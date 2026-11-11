// Read-only: find the Uniswap v4 wBRL/USDC pool on Celo and quote round trips against Textile. No transactions.
import { encodeAbiParameters, formatUnits, keccak256, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from '../src/wallet.js'
import { TOKENS } from '../src/config.js'
import { uniQuote } from '../src/uniswap.js'
import { preview } from '../src/textile.js'

const V4_QUOTER = '0x28566da1093609182dff2cb2a91cfd72e61d66cd' as Address
const STATE_VIEW = '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const WBRL = TOKENS.wBRL.address, USDC = TOKENS.USDC.address, USDT = TOKENS.USDT.address
const [c0, c1] = WBRL.toLowerCase() < USDC.toLowerCase() ? [WBRL, USDC] : [USDC, WBRL]

const keyType = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
const svAbi = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)'])
const qAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
type Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

async function v4(key: Key, tin: Address, amt: bigint) {
  try {
    const { result } = await pub.simulateContract({ address: V4_QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: tin.toLowerCase() === key.currency0.toLowerCase(), exactAmount: amt, hookData: '0x' }] })
    return result[0]
  } catch { return null }
}

// 1) Find wBRL/USDC v4 pools (standard settings, no hook) that hold liquidity
const found: { key: Key; id: string; out100: bigint }[] = []
for (const fee of [100, 500, 3000, 10000, 50, 200, 250, 400, 1000, 1500, 0x800000])
  for (const ts of [1, 5, 10, 30, 50, 60, 100, 200]) {
    const key: Key = { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: ZERO }
    const id = keccak256(encodeAbiParameters(keyType, [c0, c1, fee, ts, ZERO]))
    const liq = await pub.readContract({ address: STATE_VIEW, abi: svAbi, functionName: 'getLiquidity', args: [id] }).catch(() => 0n)
    if (liq > 0n) {
      const out100 = (await v4(key, USDC, parseUnits('100', 6))) ?? 0n
      found.push({ key, id, out100 })
      console.log(`pool: fee ${fee === 0x800000 ? 'dynamic' : fee / 100 + ' bps'}, tick spacing ${ts}  -> $100 USDC buys ${Number(formatUnits(out100, 18)).toFixed(2)} wBRL   id ${id}`)
    }
  }
if (!found.length) { console.log('No standard wBRL/USDC v4 pool found. It may use a hook: ask for the pool id or a link.'); process.exit(0) }
const best = found.sort((a, b) => (b.out100 > a.out100 ? 1 : -1))[0]
console.log(`\nUsing the best pool: fee ${best.key.fee / 100} bps, tick spacing ${best.key.tickSpacing}\n`)

// 2) Round trips. Textile on Celo quotes wBRL vs USDT, so each loop includes a USDC<->USDT hop on Uniswap v3.
const tex = async (sell: Address, buy: Address, amt: bigint) => {
  try { const p: any = await preview({ sellToken: sell, buyToken: buy, sellAmount: amt.toString() }); return p.status === 'preview' ? BigInt(p.buyAmount) : null } catch { return null }
}
const show = (out: bigint | null, usd: number) => (out === null ? 'n/a' : `${((Number(out) / 1e6 / usd - 1) * 1e4).toFixed(1).padStart(7)} bps ($${(Number(out) / 1e6 - usd).toFixed(3)})`)
console.log('Size    A: USDT->wBRL (Textile)->USDC (v4)->USDT     B: USDT->USDC->wBRL (v4)->USDT (Textile)     [USDC->USDT hop alone]')
for (const usd of [20, 100, 250, 500, 1000]) {
  const amt = parseUnits(String(usd), 6)
  // A
  const w = await tex(USDT, WBRL, amt)
  const u = w !== null ? await v4(best.key, WBRL, w) : null
  const backA = u !== null ? (await uniQuote('USDC', 'USDT', u))?.out ?? null : null
  // B
  const c = (await uniQuote('USDT', 'USDC', amt))?.out ?? null
  const w2 = c !== null ? await v4(best.key, USDC, c) : null
  const backB = w2 !== null ? await tex(WBRL, USDT, w2) : null
  const hop = (await uniQuote('USDC', 'USDT', amt))?.out ?? null
  console.log(`$${String(usd).padStart(4)}   ${show(backA, usd).padEnd(44)} ${show(backB, usd).padEnd(44)} ${show(hop, usd)}`)
}
