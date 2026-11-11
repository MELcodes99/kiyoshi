// Read-only: stablecoin pairs across Sui DEXes (via DexScreener). No wallet, no transactions.
const STABLES: Record<string, string> = {
  USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  wUSDT: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
  suiUSDT: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
  AUSD: '0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD',
  BUCK: '0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK',
  USDY: '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY',
  FDUSD: '0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD',
}
const MIN_LIQ = Number(process.env.MIN_LIQ ?? 10000)
const nameOf = new Map(Object.entries(STABLES).map(([k, v]) => [v.toLowerCase(), k]))

const seen = new Map<string, any>()
for (const [sym, type] of Object.entries(STABLES)) {
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/sui/${encodeURIComponent(type)}`)
    const pairs: any[] = r.ok ? await r.json() : []
    console.log(`${sym.padEnd(8)} ${pairs.length} pools found`)
    for (const p of pairs) seen.set(p.pairAddress, p)
  } catch (e: any) { console.log(`${sym.padEnd(8)} lookup failed: ${e.message}`) }
}

// Group stable-vs-stable pools by pair; price = units of B per 1 A
const groups = new Map<string, { dex: string; liq: number; vol: number; price: number; pool: string }[]>()
for (const p of seen.values()) {
  const a = nameOf.get(p.baseToken.address.toLowerCase()), b = nameOf.get(p.quoteToken.address.toLowerCase())
  if (!a || !b) continue
  const [A, B] = [a, b].sort()
  const native = Number(p.priceNative)
  const price = a === A ? native : 1 / native
  if (!isFinite(price) || price <= 0) continue
  const key = `${A}/${B}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key)!.push({ dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('/') : ''), liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, price, pool: p.pairAddress })
}

console.log(`\nStablecoin pairs on Sui (pools with >= $${MIN_LIQ.toLocaleString()} liquidity)\n`)
const leads: string[] = []
for (const [key, rows] of [...groups].sort()) {
  const deep = rows.filter((r) => r.liq >= MIN_LIQ).sort((x, y) => y.liq - x.liq)
  if (!deep.length) continue
  console.log(`=== ${key}`)
  for (const r of deep) console.log(`   ${r.dex.padEnd(18)} liq $${Math.round(r.liq).toLocaleString().padStart(12)}  24h vol $${Math.round(r.vol).toLocaleString().padStart(12)}  price ${r.price.toFixed(6)}`)
  if (deep.length >= 2) {
    const lo = deep.reduce((m, r) => (r.price < m.price ? r : m)), hi = deep.reduce((m, r) => (r.price > m.price ? r : m))
    const gap = (hi.price / lo.price - 1) * 1e4
    console.log(`   gap ${gap.toFixed(1)} bps  (buy on ${lo.dex}, sell on ${hi.dex})`)
    if (gap >= 10) leads.push(`${key}: ${gap.toFixed(1)} bps between ${lo.dex} and ${hi.dex}`)
  } else console.log('   only one deep pool, nothing to compare')
}
console.log('\nLeads (>= 10 bps between deep pools):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
