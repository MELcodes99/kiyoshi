// Read-only: every Uniswap v4 pool on Celo that Kiyoshi could trade, with live Textile round trips. No wallet.
import { createPublicClient, decodeEventLog, encodeEventTopics, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { celo } from 'viem/chains'

const KEY = process.env.BLOCKSCOUT_API_KEY
if (!KEY) throw new Error('Run with BLOCKSCOUT_API_KEY=proapi_... in front')
const client = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC ?? 'https://forno.celo.org') })
const POOL_MANAGER = '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC'
const STATE_VIEW = '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as Address
const V4_QUOTER = '0x28566da1093609182dff2cb2a91cfd72e61d66cd' as Address
const V3_QUOTER = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8' as Address
const T: Record<string, string> = {
  USDT: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', USDC: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
  wBRL: '0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0', wARS: '0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d',
  cNGN: '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f', BRLA: '0xfecb3f7c54e2caae9dc6ac9060a822d47e053760',
  USAT: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771',
}
const SYM = new Map(Object.entries(T).map(([k, v]) => [v, k]))
const STABLE = new Set([T.USDT, T.USDC])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const initAbi = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])
const svAbi = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)'])
const qAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const v3Abi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])

// 1) Every v4 pool ever created on Celo
const [TOPIC] = encodeEventTopics({ abi: initAbi, eventName: 'Initialize' }) as string[]
const logs: any[] = []
let from = Number(process.env.START_BLOCK ?? 30_000_000)
process.stdout.write('Loading v4 pools')
for (;;) {
  let page: any[] | null = null
  for (let i = 0; i < 8 && page === null; i++) {
    const j: any = await fetch(`https://api.blockscout.com/v2/api?chain_id=42220&apikey=${KEY}&module=logs&action=getLogs&address=${POOL_MANAGER}&topic0=${TOPIC}&fromBlock=${from}&toBlock=latest`).then((r) => r.json()).catch(() => null)
    if (Array.isArray(j?.result)) page = j.result
    else if (/no (records|logs) found/i.test(String(j?.message))) page = []
    else await sleep(2000 * (i + 1))
  }
  if (page === null) throw new Error('explorer kept failing')
  logs.push(...page)
  process.stdout.write('.')
  if (page.length < 1000) break
  from = Number(page[page.length - 1].blockNumber) + 1
}
const pools = logs.map((r) => (decodeEventLog({ abi: initAbi, data: r.data, topics: r.topics.filter(Boolean) }) as any).args)
console.log(` ${pools.length} v4 pools on Celo`)

// 2) Pools Kiyoshi could trade: Textile token vs USDT/USDC, or USDT/USDC
const relevant = pools.filter((p: any) => {
  const a = p.currency0.toLowerCase(), b = p.currency1.toLowerCase()
  return SYM.has(a) && SYM.has(b) && (STABLE.has(a) || STABLE.has(b))
})
console.log(`${relevant.length} pair a Textile token with USDT/USDC\n`)

async function textile(sell: string, buy: string, amt: bigint) {
  const res = await fetch('https://api.textilecredit.com/v2/rfq/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chainId: 42220, sellToken: sell, buyToken: buy, sellAmount: amt.toString() }) }).catch(() => null)
  const j: any = res ? await res.json().catch(() => null) : null
  return j?.data?.status === 'preview' ? BigInt(j.data.buyAmount) : null
}
async function v3(tin: string, tout: string, amt: bigint) {
  let best: bigint | null = null
  for (const fee of [100, 500, 3000]) {
    try { const { result } = await client.simulateContract({ address: V3_QUOTER, abi: v3Abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin as Address, tokenOut: tout as Address, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] }); if (best === null || result[0] > best) best = result[0] } catch {}
  }
  return best
}
const max = (a: bigint | null, b: bigint | null) => (a === null ? b : b === null ? a : a > b ? a : b)
const toUsdt = async (tok: string, amt: bigint) => (tok === T.USDT ? amt : max(await textile(tok, T.USDT, amt), await v3(tok, T.USDT, amt)))
const usdtTo = async (tok: string, amt: bigint) => (tok === T.USDT ? amt : max(await textile(T.USDT, tok, amt), await v3(T.USDT, tok, amt)))
const bps = (out: bigint | null, usd: number) => (out === null ? '   n/a' : `${((Number(formatUnits(out, 6)) / usd - 1) * 1e4).toFixed(0).padStart(6)}`)

const winners: string[] = []
for (const p of relevant) {
  const id = p.id as Hex
  const liq = await client.readContract({ address: STATE_VIEW, abi: svAbi, functionName: 'getLiquidity', args: [id] }).catch(() => 0n)
  const c0 = p.currency0.toLowerCase(), c1 = p.currency1.toLowerCase()
  const name = `${SYM.get(c0)}/${SYM.get(c1)} fee ${Number(p.fee) / 100}bps${p.hooks !== '0x0000000000000000000000000000000000000000' ? ' HOOK' : ''}`
  if (liq === 0n) { console.log(`${name.padEnd(30)} empty, skipped`); continue }
  const key = { currency0: p.currency0, currency1: p.currency1, fee: Number(p.fee), tickSpacing: Number(p.tickSpacing), hooks: p.hooks }
  const v4 = async (tin: string, amt: bigint) => { try { const { result } = await client.simulateContract({ address: V4_QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: tin === c0, exactAmount: amt, hookData: '0x' }] }); return result[0] } catch { return null } }
  // X = the non-stable side (or USDC when the pool is USDT/USDC); S = the stable side
  const S = STABLE.has(c0) && STABLE.has(c1) ? T.USDT : STABLE.has(c0) ? c0 : c1
  const X = S === c0 ? c1 : c0
  const cells: string[] = []
  let best = -Infinity
  for (const usd of [20, 100, 500]) {
    const amt = parseUnits(String(usd), 6)
    const xA = await textile(T.USDT, X, amt), sA = xA !== null ? await v4(X, xA) : null, outA = sA !== null ? await toUsdt(S, sA) : null
    const sB = await usdtTo(S, amt), xB = sB !== null ? await v4(S, sB) : null, outB = xB !== null ? await textile(X, T.USDT, xB) : null
    cells.push(`$${usd}: A ${bps(outA, usd)} B ${bps(outB, usd)}`)
    for (const o of [outA, outB]) if (o !== null) best = Math.max(best, (Number(formatUnits(o, 6)) / usd - 1) * 1e4)
    await sleep(500)
  }
  console.log(`${name.padEnd(30)} ${cells.join('   ')}  (bps; A = buy on Textile sell on v4, B = reverse)`)
  if (best > -10) winners.push(`  { id: '${id}', X: '${SYM.get(X)}', S: '${SYM.get(S)}' },   // ${name}, best +${best.toFixed(0)} bps`)
  await sleep(1000)
}
console.log('\nProfitable pools (paste into POOLS in src/v4celo.ts):')
console.log(winners.length ? winners.join('\n') : '  none right now')
