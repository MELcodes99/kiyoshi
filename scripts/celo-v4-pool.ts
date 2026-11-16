// Read-only: inspect a Uniswap v4 pool on Celo and quote Textile <-> v4 round trips. No wallet.
// Usage: npx tsx scripts/celo-v4-pool.ts [poolId]
import { createPublicClient, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, parseUnits, type Address } from 'viem'
import { celo } from 'viem/chains'

const client = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC ?? 'https://forno.celo.org') })
const POOL_ID = (process.argv[2] ?? '0xa7e41e2c1da9a6ab0a0d7e10dc1c23581c6cd9e31b449ab3a13683fa389d54f9').toLowerCase()
const POSITION_MANAGER = '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' as Address
const STATE_VIEW = '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as Address
const V4_QUOTER = '0x28566da1093609182dff2cb2a91cfd72e61d66cd' as Address
const V3_QUOTER = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8' as Address
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'.toLowerCase()
const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'.toLowerCase()

const pmAbi = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
const svAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', 'function getLiquidity(bytes32 poolId) view returns (uint128)'])
const qAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const v3Abi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const keyType = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const

// 1) Pool settings
const r = await client.readContract({ address: POSITION_MANAGER, abi: pmAbi, functionName: 'poolKeys', args: [POOL_ID.slice(0, 52) as `0x${string}`] })
const key = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }
if (keccak256(encodeAbiParameters(keyType, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])).toLowerCase() !== POOL_ID) {
  console.log('Could not read this pool\'s settings from the PositionManager. Paste this line.'); process.exit(0)
}
const info = async (a: Address) => ({ sym: await client.readContract({ address: a, abi: erc20, functionName: 'symbol' }), dec: Number(await client.readContract({ address: a, abi: erc20, functionName: 'decimals' })) })
const [t0, t1] = [await info(key.currency0), await info(key.currency1)]
const [slot0, liq] = await Promise.all([
  client.readContract({ address: STATE_VIEW, abi: svAbi, functionName: 'getSlot0', args: [POOL_ID as `0x${string}`] }),
  client.readContract({ address: STATE_VIEW, abi: svAbi, functionName: 'getLiquidity', args: [POOL_ID as `0x${string}`] }),
])
const sp = Number(slot0[0]) / 2 ** 96
const price01 = sp * sp * 10 ** (t0.dec - t1.dec)
console.log(`Pool: ${t0.sym}/${t1.sym}  fee ${key.fee === 0x800000 ? 'dynamic' : key.fee / 100 + ' bps'} (current LP fee ${Number(slot0[3]) / 100} bps)  tick spacing ${key.tickSpacing}`)
console.log(`Hook: ${key.hooks === '0x0000000000000000000000000000000000000000' ? 'none' : key.hooks}`)
console.log(`Price: 1 ${t0.sym} = ${price01.toPrecision(6)} ${t1.sym}   (1 ${t1.sym} = ${(1 / price01).toPrecision(6)} ${t0.sym})   active liquidity ${liq > 0n ? 'yes' : 'NONE'}\n`)

// 2) Quoting helpers
async function v4(tin: string, amt: bigint) {
  try {
    const { result } = await client.simulateContract({ address: V4_QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: tin === key.currency0.toLowerCase(), exactAmount: amt, hookData: '0x' }] })
    return result[0]
  } catch { return null }
}
async function v3(tin: string, tout: string, amt: bigint) {
  let best: bigint | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await client.simulateContract({ address: V3_QUOTER, abi: v3Abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin as Address, tokenOut: tout as Address, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (best === null || result[0] > best) best = result[0]
    } catch {}
  }
  return best
}
async function textile(sell: string, buy: string, amt: bigint) {
  const res = await fetch('https://api.textilecredit.com/v2/rfq/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chainId: 42220, sellToken: sell, buyToken: buy, sellAmount: amt.toString() }) }).catch(() => null)
  const j: any = res ? await res.json().catch(() => null) : null
  return j?.data?.status === 'preview' ? BigInt(j.data.buyAmount) : null
}
const max = (a: bigint | null, b: bigint | null) => (a === null ? b : b === null ? a : a > b ? a : b)
// Convert between USDT and USDC through whichever is better: Textile or Uniswap v3
const usdtTo = async (tok: string, amt: bigint) => (tok === USDT ? amt : max(await textile(USDT, tok, amt), await v3(USDT, tok, amt)))
const toUsdt = async (tok: string, amt: bigint) => (tok === USDT ? amt : max(await textile(tok, USDT, amt), await v3(tok, USDT, amt)))

// 3) Round trips: Textile vs this v4 pool, starting and ending in USDT
const c0 = key.currency0.toLowerCase(), c1 = key.currency1.toLowerCase()
const stable = [c0, c1].find((t) => t === USDT || t === USDC)
const X = stable === c0 ? c1 : c0
const xSym = X === c0 ? t0.sym : t1.sym, sSym = stable === c0 ? t0.sym : t1.sym
if (!stable) { console.log('Neither token is USDT or USDC; no Textile loop to test.'); process.exit(0) }

const fmt = (out: bigint | null, usd: number) => (out === null ? 'no quote'.padStart(26) : `${((Number(formatUnits(out, 6)) / usd - 1) * 1e4).toFixed(1).padStart(8)} bps ($${(Number(formatUnits(out, 6)) - usd).toFixed(3)})`.padEnd(26))
console.log(`Loops (start and end in USDT, after all fees and price impact):`)
console.log(`Size     A: USDT->${xSym} on Textile -> ${sSym} on v4      B: USDT->${sSym} -> ${xSym} on v4 -> USDT on Textile     (today's v3 route: B via v3)`)
for (const usd of [20, 100, 500, 1000, 2000, 5000]) {
  const amt = parseUnits(String(usd), 6)
  // A
  const xA = await textile(USDT, X, amt)
  const sA = xA !== null ? await v4(X, xA) : null
  const outA = sA !== null ? await toUsdt(stable, sA) : null
  // B
  const sB = await usdtTo(stable, amt)
  const xB = sB !== null ? await v4(stable, sB) : null
  const outB = xB !== null ? await textile(X, USDT, xB) : null
  // Same loop B but through Kiyoshi's current v3 route (USDT -> X on v3), for comparison
  const xV3 = await v3(USDT, X, amt)
  const outV3 = xV3 !== null ? await textile(X, USDT, xV3) : null
  console.log(`$${String(usd).padStart(5)}   ${fmt(outA, usd)}              ${fmt(outB, usd)}                ${fmt(outV3, usd)}`)
}
