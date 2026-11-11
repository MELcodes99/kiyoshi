// Read-only: exact Textile <-> Uniswap v4 round trips for cNGN/USDC on Base. No transactions.
import { createPublicClient, decodeEventLog, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbi, type Address } from 'viem'
import { base } from 'viem/chains'

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC ?? 'https://mainnet.base.org') })
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F' as Address
const V4_QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

// 1) find the pool id from DexScreener, then recover its key by trying the standard settings
const pairs: any[] = await (await fetch(`https://api.dexscreener.com/tokens/v1/base/${CNGN}`)).json()
const pool = pairs.filter((p) => p.dexId === 'uniswap').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
const poolId = String(pool?.pairAddress ?? '').toLowerCase()
const [c0, c1] = CNGN.toLowerCase() < USDC.toLowerCase() ? [CNGN, USDC] : [USDC, CNGN]
const keyType = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
let key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null = null
for (const fee of [100, 500, 3000, 10000, 50, 200, 250, 400, 1000, 0x800000])
  for (const ts of [1, 10, 50, 60, 100, 200]) {
    const id = keccak256(encodeAbiParameters(keyType, [c0, c1, fee, ts, ZERO])).toLowerCase()
    if (id === poolId) key = { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: ZERO }
  }
if (!key) {
  // Non-standard pool (hook or custom fee): read its key from the PoolManager's Initialize event
  const evAbi = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])
  const [t0, t1] = encodeEventTopics({ abi: evAbi, eventName: 'Initialize', args: { id: poolId as `0x${string}` } }) as string[]
  const url = `https://base.blockscout.com/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=0x498581fF718922c3f8e6A244956aF099B2652b2b&topic0=${t0}&topic1=${t1}&topic0_1_opr=and`
  const j: any = await (await fetch(url)).json().catch(() => ({}))
  const log = Array.isArray(j.result) ? j.result[0] : null
  if (log) {
    const ev: any = decodeEventLog({ abi: evAbi, data: log.data, topics: log.topics.filter(Boolean) })
    key = { currency0: ev.args.currency0, currency1: ev.args.currency1, fee: Number(ev.args.fee), tickSpacing: Number(ev.args.tickSpacing), hooks: ev.args.hooks }
    console.log(`Pool key read onchain. Hook contract: ${key.hooks}`)
  }
}
if (!key) { console.log(`Could not read the key for pool ${poolId}; paste this line.`); process.exit(0) }
console.log(`Pool found: fee ${key.fee === 0x800000 ? 'dynamic' : key.fee / 100 + ' bps'}, tick spacing ${key.tickSpacing}\n`)

// 2) exact v4 quotes
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
  if (!r.ok) return `HTTP ${r.status}`
  return j.data?.status === 'preview' ? BigInt(j.data.buyAmount) : `no quote (${j.data?.reason})`
}
const show = (out: bigint | null | string, usd: number) =>
  typeof out === 'bigint' ? `${((Number(out) / 1e6 / usd - 1) * 1e4).toFixed(1).padStart(7)} bps  ($${(Number(out) / 1e6 - usd).toFixed(3)})` : String(out ?? 'pool quote failed')

console.log('Size    Textile->Uniswap v4              Uniswap v4->Textile')
for (const usd of [20, 100, 250, 500, 1000]) {
  const amt = BigInt(usd * 1e6)
  // Route A: buy cNGN on Textile, sell into the pool
  const t = await textile(USDC, CNGN, amt)
  const a = typeof t === 'bigint' ? await v4(CNGN, t) : t
  // Route B: buy cNGN in the pool, sell to Textile
  const p = await v4(USDC, amt)
  const b = p !== null ? await textile(CNGN, USDC, p) : null
  console.log(`$${String(usd).padStart(4)}   ${show(a, usd).padEnd(32)} ${show(b, usd)}`)
}
