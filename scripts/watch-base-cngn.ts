// Read-only watcher: cNGN round trips on Base (Textile <-> Uniswap v4), every INTERVAL_SEC. No transactions.
// Usage:  npx tsx scripts/watch-base-cngn.ts          (watch and log)
//         npx tsx scripts/watch-base-cngn.ts report   (summarise the log)
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, type Address } from 'viem'
import { base } from 'viem/chains'

const LOG = 'base-cngn-watch.jsonl'
const SIZES = [100, 250, 500, 1000]
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '60') * 1000

if (process.argv[2] === 'report') {
  if (!existsSync(LOG)) { console.log('No log yet. Run the watcher first.'); process.exit(0) }
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const hours = (Date.parse(rows.at(-1).ts) - Date.parse(rows[0].ts)) / 3.6e6
  console.log(`${rows.length} checks over ${hours.toFixed(1)} hours (${rows[0].ts.slice(0, 16)} to ${rows.at(-1).ts.slice(0, 16)})\n`)
  console.log('Size    % of checks positive   avg edge     best edge    est. $/day if traded every positive check (max 1 per check)')
  for (const s of SIZES) {
    const v = rows.map((r) => r.edges?.[s]).filter((x: any) => typeof x === 'number') as number[]
    if (!v.length) continue
    const pos = v.filter((x) => x > 0)
    const perDay = hours > 0 ? (pos.reduce((a, b) => a + b, 0) / hours) * 24 : 0
    console.log(`$${String(s).padStart(4)}   ${((pos.length / v.length) * 100).toFixed(0).padStart(5)}%               $${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3).padStart(7)}     $${Math.max(...v).toFixed(3).padStart(7)}     $${perDay.toFixed(2)}`)
  }
  const best = rows.filter((r) => r.bestUsd > 0).sort((a, b) => b.bestUsd - a.bestUsd).slice(0, 5)
  if (best.length) { console.log('\nBiggest moments:'); for (const r of best) console.log(`  ${r.ts.slice(0, 16)}  +$${r.bestUsd.toFixed(3)} at $${r.bestSize}`) }
  console.log('\nNote: estimates ignore gas (about 1-2 cents per round trip on Base) and assume the gap is still there when trading.')
  process.exit(0)
}

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC ?? 'https://mainnet.base.org') })
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F' as Address
const POOL_ID = '0x84fa97768196067f0e5aa157709039a3897e219cba3002d9ad38bf44e300fe93'
const V4_QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address
const KEY = { currency0: CNGN, currency1: USDC, fee: 1500, tickSpacing: 30, hooks: '0x0000000000000000000000000000000000000000' as Address }
const keyType = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
if (keccak256(encodeAbiParameters(keyType, [KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks])).toLowerCase() !== POOL_ID) throw new Error('pool key does not match the cNGN pool id')

const qAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
async function v4(tin: Address, amt: bigint) {
  try {
    const { result } = await client.simulateContract({ address: V4_QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: KEY, zeroForOne: tin === KEY.currency0, exactAmount: amt, hookData: '0x' }] })
    return result[0]
  } catch { return null }
}
async function textile(sell: Address, buy: Address, amt: bigint): Promise<bigint | null> {
  try {
    const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: 8453, sellToken: sell, buyToken: buy, sellAmount: amt.toString() }),
    })
    const j: any = await r.json()
    return r.ok && j.data?.status === 'preview' ? BigInt(j.data.buyAmount) : null
  } catch { return null }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`Watching cNGN on Base every ${INTERVAL_MS / 1000}s. Logging to ${LOG}. Ctrl+C to stop.\n`)
for (;;) {
  const edges: Record<number, number | null> = {}
  const routes: Record<number, string> = {}
  for (const usd of SIZES) {
    const amt = BigInt(usd * 1e6)
    const t = await textile(USDC, CNGN, amt)                 // A: buy on Textile...
    const a = t !== null ? await v4(CNGN, t) : null          //    ...sell into the pool
    const p = await v4(USDC, amt)                            // B: buy in the pool...
    const b = p !== null ? await textile(CNGN, USDC, p) : null //  ...sell to Textile
    const ea = a !== null ? Number(a) / 1e6 - usd : null
    const eb = b !== null ? Number(b) / 1e6 - usd : null
    const best = Math.max(ea ?? -Infinity, eb ?? -Infinity)
    edges[usd] = isFinite(best) ? +best.toFixed(4) : null
    routes[usd] = ea !== null && (eb === null || ea >= eb) ? 'tex->uni' : 'uni->tex'
  }
  const valid = SIZES.filter((s) => edges[s] !== null)
  const bestSize = valid.sort((x, y) => (edges[y] as number) - (edges[x] as number))[0]
  const row = { ts: new Date().toISOString(), edges, routes, bestSize, bestUsd: bestSize ? edges[bestSize] : null }
  appendFileSync(LOG, JSON.stringify(row) + '\n')
  const fmt = (s: number) => (edges[s] === null ? '   n/a ' : `${(edges[s]! >= 0 ? '+' : '')}${edges[s]!.toFixed(3)}`)
  console.log(`${row.ts.slice(11, 19)}  ${SIZES.map((s) => `$${s}: ${fmt(s)}`).join('   ')}${row.bestUsd && row.bestUsd > 0 ? `   << +$${row.bestUsd.toFixed(3)} (${routes[bestSize]})` : ''}`)
  await sleep(INTERVAL_MS)
}
