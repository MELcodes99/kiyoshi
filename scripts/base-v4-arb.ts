// Read-only: Textile <-> Uniswap v4 round trips on Base for any token vs USDC. No transactions.
// Usage: npx tsx scripts/base-v4-arb.ts <token address> <v4 pool id>
import { createPublicClient, decodeEventLog, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbi, type Address } from 'viem'
import { base } from 'viem/chains'

const [TOKEN, POOL_ID] = process.argv.slice(2) as [Address, string]
if (!TOKEN || !POOL_ID) { console.log('usage: npx tsx scripts/base-v4-arb.ts <token> <poolId>'); process.exit(1) }
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC ?? 'https://mainnet.base.org') })
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const V4_QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address
const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b'
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const erc20 = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
const [dec, sym] = await Promise.all([
  client.readContract({ address: TOKEN, abi: erc20, functionName: 'decimals' }),
  client.readContract({ address: TOKEN, abi: erc20, functionName: 'symbol' }),
])

// Pool key: try standard settings, else read the Initialize event
const poolId = POOL_ID.toLowerCase()
const [c0, c1] = TOKEN.toLowerCase() < USDC.toLowerCase() ? [TOKEN, USDC] : [USDC, TOKEN]
const keyType = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
let key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null = null
for (const fee of [100, 500, 3000, 10000, 50, 200, 250, 400, 1000, 0x800000])
  for (const ts of [1, 10, 50, 60, 100, 200])
    if (keccak256(encodeAbiParameters(keyType, [c0, c1, fee, ts, ZERO])).toLowerCase() === poolId) key = { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: ZERO }
if (!key) {
  // Uniswap v4 PositionManager stores each pool's key by the first 25 bytes of its id
  const pmAbi = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
  try {
    const r: any = await client.readContract({ address: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', abi: pmAbi, functionName: 'poolKeys', args: [poolId.slice(0, 52) as `0x${string}`] })
    const k = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }
    const id = keccak256(encodeAbiParameters(keyType, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks])).toLowerCase()
    if (id === poolId) key = k
    else console.log('PositionManager returned a key that does not match this pool id')
  } catch (e: any) { console.log('PositionManager lookup failed:', e.shortMessage ?? e.message) }
}
if (!key) {
  const evAbi = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])
  const [t0, t1] = encodeEventTopics({ abi: evAbi, eventName: 'Initialize', args: { id: poolId as `0x${string}` } }) as string[]
  const j: any = await (await fetch(`https://base.blockscout.com/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${POOL_MANAGER}&topic0=${t0}&topic1=${t1}&topic0_1_opr=and`)).json().catch(() => ({}))
  const log = Array.isArray(j.result) ? j.result[0] : null
  if (!log) console.log('Blockscout lookup:', j.message ?? j.status ?? 'no result')
  if (log) {
    const ev: any = decodeEventLog({ abi: evAbi, data: log.data, topics: log.topics.filter(Boolean) })
    key = { currency0: ev.args.currency0, currency1: ev.args.currency1, fee: Number(ev.args.fee), tickSpacing: Number(ev.args.tickSpacing), hooks: ev.args.hooks }
  }
}
if (!key) { console.log(`Could not read the key for pool ${poolId}`); process.exit(0) }
console.log(`${sym} (${dec} decimals) | pool fee ${key.fee === 0x800000 ? 'dynamic' : key.fee / 100 + ' bps'}, tick spacing ${key.tickSpacing}, hook ${key.hooks === ZERO ? 'none' : key.hooks}\n`)

const qAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
async function v4(tin: Address, amt: bigint) {
  try {
    const { result } = await client.simulateContract({ address: V4_QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key!, zeroForOne: tin.toLowerCase() === key!.currency0.toLowerCase(), exactAmount: amt, hookData: '0x' }] })
    return result[0]
  } catch { return null }
}
async function textile(sell: Address, buy: Address, amt: bigint): Promise<bigint | string> {
  const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId: 8453, sellToken: sell, buyToken: buy, sellAmount: amt.toString() }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return `Textile HTTP ${r.status}${j?.code ? ' ' + j.code : ''}`
  return j.data?.status === 'preview' ? BigInt(j.data.buyAmount) : `Textile no quote (${j.data?.reason})`
}
const show = (out: bigint | null | string, usd: number) =>
  typeof out === 'bigint' ? `${((Number(out) / 1e6 / usd - 1) * 1e4).toFixed(1).padStart(7)} bps  ($${(Number(out) / 1e6 - usd).toFixed(3)})` : String(out ?? 'pool quote failed')

console.log('Size    Textile->Uniswap v4                 Uniswap v4->Textile')
for (const usd of [20, 100, 250, 500, 1000]) {
  const amt = BigInt(usd * 1e6)
  const t = await textile(USDC, TOKEN, amt)
  const a = typeof t === 'bigint' ? await v4(TOKEN, t) : t
  const p = await v4(USDC, amt)
  const b = p !== null ? await textile(TOKEN, USDC, p) : null
  console.log(`$${String(usd).padStart(4)}   ${show(a, usd).padEnd(35)} ${show(b, usd)}`)
}
