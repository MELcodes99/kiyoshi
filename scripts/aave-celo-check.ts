// Read-only: size of Aave v3 on Celo, its liquidation history, and borrowers close to liquidation. No wallet.
import { createPublicClient, decodeEventLog, encodeEventTopics, formatUnits, http, parseAbi, type Address } from 'viem'
import { celo } from 'viem/chains'
import { RPC_URL } from '../src/config.js'

const pub = createPublicClient({ chain: celo, transport: http(RPC_URL) })
const POOL = '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402' as Address
const KEY = process.env.BLOCKSCOUT_API_KEY
const API = KEY ? `https://api.blockscout.com/v2/api?chain_id=42220&apikey=${KEY}&` : 'https://celo.blockscout.com/api?'
const FROM = Number(process.env.FROM_BLOCK ?? 30_000_000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const poolAbi = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function getReserveData(address) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
])
const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)'])
const provAbi = parseAbi(['function getPriceOracle() view returns (address)'])
const oracleAbi = parseAbi(['function getAssetPrice(address) view returns (uint256)'])
const events = parseAbi([
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
])

// 0) Confirm this really is an Aave v3 Pool
const provider = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' }).catch(() => null)
if (!provider) { console.log('This address does not behave like an Aave v3 Pool; stopping.'); process.exit(0) }
const oracle = await pub.readContract({ address: provider, abi: provAbi, functionName: 'getPriceOracle' })
const reserves = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getReservesList' })

// 1) Market size
type R = { sym: string; dec: number; price: number }
const info = new Map<string, R>()
let totalSupplied = 0, totalBorrowed = 0
console.log('=== Aave v3 on Celo: market size')
for (const a of reserves) {
  const [sym, dec, rd, px] = await Promise.all([
    pub.readContract({ address: a, abi: erc20, functionName: 'symbol' }),
    pub.readContract({ address: a, abi: erc20, functionName: 'decimals' }),
    pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getReserveData', args: [a] }),
    pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [a] }),
  ])
  const price = Number(px) / 1e8
  info.set(a.toLowerCase(), { sym, dec, price })
  const [sup, bor] = await Promise.all([
    pub.readContract({ address: rd.aTokenAddress, abi: erc20, functionName: 'totalSupply' }),
    pub.readContract({ address: rd.variableDebtTokenAddress, abi: erc20, functionName: 'totalSupply' }),
  ])
  const s = Number(formatUnits(sup, dec)) * price, b = Number(formatUnits(bor, dec)) * price
  totalSupplied += s; totalBorrowed += b
  console.log(`   ${sym.padEnd(8)} supplied $${Math.round(s).toLocaleString().padStart(12)}   borrowed $${Math.round(b).toLocaleString().padStart(12)}   price $${price.toFixed(4)}`)
}
console.log(`   TOTAL    supplied $${Math.round(totalSupplied).toLocaleString()}   borrowed $${Math.round(totalBorrowed).toLocaleString()}\n`)

// Explorer log fetcher (paginates by block, retries on rate limit)
async function logs(topics: string[]): Promise<any[]> {
  const out: any[] = [], seen = new Set<string>()
  let from = FROM
  for (;;) {
    let rows: any[] | null = null
    for (let i = 0; i < 10 && rows === null; i++) {
      const tq = topics.map((t, k) => `&topic${k}=${t}`).join('') + (topics.length > 1 ? '&topic0_1_opr=and' : '')
      const j: any = await fetch(`${API}module=logs&action=getLogs&address=${POOL}&fromBlock=${from}&toBlock=latest${tq}`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}))
      if (Array.isArray(j.result)) rows = j.result
      else if (/no (records|logs) found/i.test(String(j.message))) rows = []
      else await sleep(2000 * (i + 1))
    }
    if (rows === null) throw new Error('explorer kept failing')
    for (const r of rows) { const k = r.transactionHash + ':' + r.logIndex; if (!seen.has(k)) { seen.add(k); out.push(r) } }
    if (rows.length < 1000) return out
    from = Number(rows[rows.length - 1].blockNumber)
    await sleep(300)
  }
}
const decode = (r: any) => decodeEventLog({ abi: events, data: r.data, topics: r.topics.filter(Boolean) }) as any

// 2) Liquidation history
const [liqTopic] = encodeEventTopics({ abi: events, eventName: 'LiquidationCall' }) as string[]
const liqs = (await logs([liqTopic])).map((r) => ({ ...decode(r).args, block: Number(r.blockNumber), ts: Number(r.timeStamp) }))
const byLiquidator = new Map<string, { n: number; profit: number }>()
let totalProfit = 0, totalRepaid = 0
for (const l of liqs) {
  const c = info.get(String(l.collateralAsset).toLowerCase()), d = info.get(String(l.debtAsset).toLowerCase())
  if (!c || !d) continue
  const repaid = Number(formatUnits(l.debtToCover, d.dec)) * d.price
  const seized = Number(formatUnits(l.liquidatedCollateralAmount, c.dec)) * c.price
  const profit = seized - repaid // liquidation bonus, before gas and swap costs, at today's prices
  totalProfit += profit; totalRepaid += repaid
  const k = String(l.liquidator).toLowerCase()
  const e = byLiquidator.get(k) ?? { n: 0, profit: 0 }; e.n++; e.profit += profit; byLiquidator.set(k, e)
}
console.log('=== Liquidation history')
if (!liqs.length) console.log('   no liquidations found')
else {
  const first = new Date(liqs[0].ts * 1000).toISOString().slice(0, 10), last = new Date(liqs.at(-1).ts * 1000).toISOString().slice(0, 10)
  console.log(`   ${liqs.length} liquidations from ${first} to ${last}`)
  console.log(`   debt repaid ~$${Math.round(totalRepaid).toLocaleString()}, liquidator bonus ~$${Math.round(totalProfit).toLocaleString()} (at today's prices, before costs)`)
  console.log(`   ${byLiquidator.size} different liquidator addresses:`)
  for (const [k, v] of [...byLiquidator].sort((a, b) => b[1].profit - a[1].profit).slice(0, 8)) console.log(`      ${k}  ${String(v.n).padStart(5)} liquidations   ~$${Math.round(v.profit).toLocaleString()}`)
  const days = new Map<string, number>()
  for (const l of liqs) { const d = new Date(l.ts * 1000).toISOString().slice(0, 10); days.set(d, (days.get(d) ?? 0) + 1) }
  console.log(`   busiest days: ${[...days].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} (${n})`).join(', ')}`)
}

// 3) Borrowers close to liquidation right now
const [borrowTopic] = encodeEventTopics({ abi: events, eventName: 'Borrow' }) as string[]
const borrowers = [...new Set((await logs([borrowTopic])).map((r) => String(decode(r).args.onBehalfOf).toLowerCase()))] as Address[]
console.log(`\n=== Current borrowers: ${borrowers.length} addresses have ever borrowed`)
const rows: { u: string; debt: number; coll: number; hf: number }[] = []
for (let i = 0; i < borrowers.length; i += 100) {
  const res = await pub.multicall({ contracts: borrowers.slice(i, i + 100).map((u) => ({ address: POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [u] })) as any })
  res.forEach((r: any, k) => {
    if (r.status !== 'success') return
    const [coll, debt, , , , hf] = r.result as bigint[]
    if (debt > 0n) rows.push({ u: borrowers[i + k], debt: Number(debt) / 1e8, coll: Number(coll) / 1e8, hf: Number(hf) / 1e18 })
  })
}
const band = (lo: number, hi: number) => rows.filter((r) => r.hf >= lo && r.hf < hi)
const sum = (rs: typeof rows) => Math.round(rs.reduce((s, r) => s + r.debt, 0)).toLocaleString()
console.log(`   ${rows.length} with open debt, $${sum(rows)} borrowed in total`)
console.log(`   health < 1.00 (liquidatable now): ${band(0, 1).length} positions, $${sum(band(0, 1))} debt`)
console.log(`   health 1.00 to 1.05:              ${band(1, 1.05).length} positions, $${sum(band(1, 1.05))} debt`)
console.log(`   health 1.05 to 1.20:              ${band(1.05, 1.2).length} positions, $${sum(band(1.05, 1.2))} debt`)
for (const r of rows.sort((a, b) => a.hf - b.hf).slice(0, 8)) console.log(`      ${r.u}  health ${r.hf.toFixed(3)}  debt $${Math.round(r.debt).toLocaleString()}  collateral $${Math.round(r.coll).toLocaleString()}`)
