// Uniswap v4 venue for Kiyoshi on Celo: quotes and swaps through configured v4 pools
// (Universal Router + Permit2), traded against Textile. Every tx goes through sendTagged.
import { decodeEventLog, encodeFunctionData, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { account, pub, sendTaggedReceipt } from './wallet.js'
import { TOKENS, type TokenKey } from './config.js'
import { balanceOf, ensureAllowance, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuote, uniSwap } from './uniswap.js'
import { encodeExactInSingle, poolId, type PoolKey } from './base/v4.js'
import { edgeUsd, shouldHold, usd, withSlippage as slip } from './strategy.js'

// Uniswap v4 on Celo (developers.uniswap.org v4 deployments)
export const V4 = {
  QUOTER: '0x28566da1093609182dff2cb2a91cfd72e61d66cd' as Address,
  ROUTER: '0xcb695bc5d3aa22cad1e6df07801b061a05a0233a' as Address,
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  POSITION_MANAGER: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' as Address,
}
// v4 pools traded against Textile. X = corridor token, S = the stablecoin it is paired with in the pool.
const POOLS: { id: Hex; X: TokenKey; S: TokenKey }[] = [
  { id: '0xa7e41e2c1da9a6ab0a0d7e10dc1c23581c6cd9e31b449ab3a13683fa389d54f9', X: 'wBRL', S: 'USDC' },
]

const pmAbi = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const MAX_UINT160 = (1n << 160n) - 1n
const FALLBACK = (process.env.V4_FALLBACK_USD ?? '25,20,15,10').split(',').map((v) => parseUnits(v.trim(), 6))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Loaded = { X: TokenKey; S: TokenKey; key: PoolKey }
let loaded: Loaded[] | null = null
async function pools(): Promise<Loaded[]> {
  if (loaded) return loaded
  const out: Loaded[] = []
  const code = await pub.getCode({ address: V4.PERMIT2 }).catch(() => undefined)
  if (!code || code === '0x') { console.log('  v4: Permit2 not found on Celo; v4 routes disabled'); return (loaded = []) }
  for (const p of POOLS) {
    try {
      const r = await pub.readContract({ address: V4.POSITION_MANAGER, abi: pmAbi, functionName: 'poolKeys', args: [p.id.slice(0, 52) as Hex] })
      const key: PoolKey = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }
      if (poolId(key).toLowerCase() !== p.id.toLowerCase()) throw new Error('key does not match pool id')
      out.push({ X: p.X, S: p.S, key })
      console.log(`  v4: loaded ${p.X}/${p.S} pool (fee ${key.fee / 100} bps, tick spacing ${key.tickSpacing})`)
    } catch (e: any) { console.log(`  v4: could not load pool ${p.id}: ${e.shortMessage ?? e.message}`) }
  }
  return (loaded = out)
}

export async function v4Quote(key: PoolKey, tokenIn: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await pub.simulateContract({
      address: V4.QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne: tokenIn.toLowerCase() === key.currency0.toLowerCase(), exactAmount: amountIn, hookData: '0x' }],
    })
    return result[0]
  } catch { return null }
}

async function ensurePermit2(token: Address, amount: bigint) {
  await ensureAllowance(token, V4.PERMIT2, amount)
  const [allowed, expiration] = await pub.readContract({ address: V4.PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [account.address, token, V4.ROUTER] })
  const now = Math.floor(Date.now() / 1000)
  if (allowed >= amount && expiration > now + 3600) return
  await sendTaggedReceipt({ to: V4.PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, V4.ROUTER, MAX_UINT160, now + 30 * 86400] }) })
}

/** Exact-input swap through a v4 pool; the router reverts if output < minOut. */
export async function v4Swap(key: PoolKey, tokenIn: Address, amountIn: bigint, minOut: bigint): Promise<{ hash: Hex; out: bigint }> {
  const tokenOut = tokenIn.toLowerCase() === key.currency0.toLowerCase() ? key.currency1 : key.currency0
  for (let i = 0; (await balanceOf(tokenIn)) < amountIn && i < 15; i++) await sleep(1000)
  await ensurePermit2(tokenIn, amountIn)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
  const receipt = await sendTaggedReceipt({ to: V4.ROUTER, data: encodeExactInSingle(key, tokenIn, amountIn, minOut, deadline) })
  let out = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenOut.toLowerCase()) continue
    try {
      const ev: any = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics })
      if (String(ev.args.to).toLowerCase() === account.address.toLowerCase()) out += ev.args.value
    } catch {}
  }
  if (out === 0n) out = minOut
  return { hash: receipt.transactionHash, out }
}

async function texPreview(sell: TokenKey, buy: TokenKey, amount: bigint): Promise<bigint | null> {
  try {
    const p: any = await preview({ sellToken: TOKENS[sell].address, buyToken: TOKENS[buy].address, sellAmount: amount.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}

// USDT <-> stable conversion through the better of Textile and Uniswap v3
type Conv = { venue: 'none' | 'uniswap' | 'textile'; out: bigint; fee?: number }
async function quoteConv(from: TokenKey, to: TokenKey, amt: bigint): Promise<Conv | null> {
  if (from === to) return { venue: 'none', out: amt }
  const [u, t] = await Promise.all([uniQuote(from, to, amt), texPreview(from, to, amt)])
  if (u && (t === null || u.out >= t)) return { venue: 'uniswap', out: u.out, fee: u.fee }
  if (t !== null) return { venue: 'textile', out: t }
  return null
}
async function doConv(c: Conv, from: TokenKey, to: TokenKey, amt: bigint, minOut: bigint): Promise<{ out: bigint; tx?: string; textileUsd?: number } | null> {
  if (c.venue === 'none') return { out: amt }
  if (c.venue === 'uniswap') { const r = await uniSwap(from, to, amt, c.fee!, minOut); return { out: r.out, tx: r.hash } }
  const r = await textileSwap(from, to, amt, minOut)
  return r.status === 'filled' ? { out: r.received, tx: r.txHash, textileUsd: usd(r.received) } : null
}

export type V4Opp = {
  X: TokenKey; route: 'textile->v4' | 'v4->textile'; size: bigint; mid: bigint; out: bigint; uniFee: number; edge: number
  v4: { S: TokenKey; key: PoolKey; conv: Conv }
}

/** Quote both v4 routes for every configured pool, ending in USDT like every other Kiyoshi route. */
export async function scanV4(size: bigint, only?: Set<TokenKey>, chase?: { X: TokenKey; route: string } | null): Promise<V4Opp[]> {
  if (process.env.V4_DISABLED === '1') return []
  const out: V4Opp[] = []
  for (const p of await pools()) {
    if (only && !only.has(p.X)) continue
    if (chase && (chase.X !== p.X || !chase.route.includes('v4'))) continue
    const xT = TOKENS[p.X].address, sT = TOKENS[p.S].address
    if (!chase || chase.route === 'textile->v4') { // USDT -> X on Textile -> S on v4 -> USDT
      // Textile makers may only sell small amounts of X, so fall back to smaller sizes when the full size has no quote
      for (const sz of [size, ...FALLBACK.filter((f) => f < size)]) {
        const x = await texPreview('USDT', p.X, sz)
        if (x === null) continue
        const s = await v4Quote(p.key, xT, x)
        const c = s !== null ? await quoteConv(p.S, 'USDT', s) : null
        if (s !== null && c) out.push({ X: p.X, route: 'textile->v4', size: sz, mid: x, out: c.out, uniFee: 0, edge: edgeUsd(c.out, sz), v4: { S: p.S, key: p.key, conv: c } })
        break
      }
    }
    if (!chase || chase.route === 'v4->textile') { // USDT -> S -> X on v4 -> USDT on Textile
      const c = await quoteConv('USDT', p.S, size)
      const x = c ? await v4Quote(p.key, sT, c.out) : null
      const back = x !== null ? await texPreview(p.X, 'USDT', x) : null
      if (c && x !== null && back !== null) out.push({ X: p.X, route: 'v4->textile', size, mid: x, out: back, uniFee: 0, edge: edgeUsd(back, size), v4: { S: p.S, key: p.key, conv: c } })
    }
  }
  return out
}

export type V4Ctx = {
  pending: Map<TokenKey, { costUsdt: bigint; since: number }>
  log: (e: Record<string, any>) => void
  maxLossBps: bigint; maxHoldMs: number; minEdgeUnits: bigint; slippageBps: bigint
}

/** Execute a v4 route with the same guard rails as the v3 routes. Returns realized P&L or null if incomplete. */
export async function executeV4(o: V4Opp, ctx: V4Ctx): Promise<number | null> {
  const { S, key } = o.v4
  const xT = TOKENS[o.X].address, sT = TOKENS[S].address
  const ws = (v: bigint) => slip(v, ctx.slippageBps)
  const minX = (o.mid * (o.size + ctx.minEdgeUnits)) / o.out // least X the first leg must deliver to still clear min edge
  const base = { event: 'cycle', X: o.X, route: o.route, sizeUsd: usd(o.size) }

  if (o.route === 'textile->v4') {
    const r1 = await textileSwap('USDT', o.X, o.size, minX)
    if (r1.status !== 'filled') { ctx.log({ ...base, leg1: r1.status, pnl: null }); return null }
    const q = await v4Quote(key, xT, r1.received)
    const qUsdt = q !== null ? (await quoteConv(S, 'USDT', q))?.out ?? null : null
    if (q === null || qUsdt === null || shouldHold(qUsdt, o.size, 0, ctx.maxLossBps, ctx.maxHoldMs)) {
      ctx.pending.set(o.X, { costUsdt: o.size, since: Date.now() })
      ctx.log({ ...base, tx1: r1.txHash, textileUsd: usd(o.size), leg2: 'v4_price_collapsed', pnl: null })
      return null
    }
    const r2 = await v4Swap(key, xT, r1.received, ws(q))
    const c = await quoteConv(S, 'USDT', r2.out)
    const r3 = c ? await doConv(c, S, 'USDT', r2.out, ws(c.out)).catch(() => null) : null
    if (!r3) {
      if (S !== 'USDT') ctx.pending.set(S, { costUsdt: o.size, since: Date.now() })
      ctx.log({ ...base, tx1: r1.txHash, tx2: r2.hash, textileUsd: usd(o.size), leg3: 'stable_conversion_pending', pnl: null })
      return null
    }
    const pnl = usd(r3.out) - usd(o.size)
    ctx.log({ ...base, tx1: r1.txHash, tx2: r2.hash, tx3: r3.tx, textileUsd: usd(o.size) + (r3.textileUsd ?? 0), pnl })
    return pnl
  }

  // v4->textile
  const r1 = await doConv(o.v4.conv, 'USDT', S, o.size, ws(o.v4.conv.out)).catch(() => null)
  if (!r1) { ctx.log({ ...base, leg1: 'stable_conversion_failed', pnl: null }); return null }
  let r2: { hash: Hex; out: bigint }
  try { r2 = await v4Swap(key, sT, r1.out, minX) } catch (e: any) {
    if (S !== 'USDT') ctx.pending.set(S, { costUsdt: o.size, since: Date.now() })
    ctx.log({ ...base, tx1: r1.tx, leg2: 'v4_failed: ' + String(e.shortMessage ?? e.message).slice(0, 80), pnl: null })
    return null
  }
  const r3 = await textileSwap(o.X, 'USDT', r2.out, o.size) // sell only if it at least breaks even
  const filled = r3.status === 'filled'
  if (!filled) ctx.pending.set(o.X, { costUsdt: o.size, since: Date.now() })
  const pnl = filled ? usd(r3.received) - usd(o.size) : null
  ctx.log({ ...base, tx1: r1.tx, tx2: r2.hash, leg3: r3.status, ...(filled ? { tx3: r3.txHash, textileUsd: usd(r3.received) + (r1.textileUsd ?? 0) } : {}), pnl })
  return pnl
}
