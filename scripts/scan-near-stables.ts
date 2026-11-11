// Read-only: stablecoin pairs across NEAR DEXes (via DexScreener). No wallet, no transactions.
const STABLES: Record<string, string> = {
  USDC: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  USDt: 'usdt.tether-token.near',
  'USDC.e': 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
  'USDT.e': 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
  'DAI.e': '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
  FRAX: '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near',
}
const MIN_LIQ = Number(process.env.MIN_LIQ ?? 10000)
const nameOf = new Map(Object.entries(STABLES).map(([k, v]) => [v.toLowerCase(), k]))

const seen = new Map<string, any>()
for (const [sym, id] of Object.entries(STABLES)) {
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/near/${encodeURIComponent(id)}`)
    const pairs: any[] = r.ok ? await r.json() : []
    console.log(`${sym.padEnd(8)} ${pairs.length} pools found`)
    for (const p of pairs) seen.set(p.pairAddress, p)
  } catch (e: any) { console.log(`${sym.padEnd(8)} lookup failed: ${e.message}`) }
}

const groups = new Map<string, { dex: string; liq: number; vol: number; price: number }[]>()
for (const p of seen.values()) {
  const a = nameOf.get(p.baseToken.address.toLowerCase()), b = nameOf.get(p.quoteToken.address.toLowerCase())
  if (!a || !b) continue
  const [A, B] = [a, b].sort()
  const native = Number(p.priceNative)
  const price = a === A ? native : 1 / native
  if (!isFinite(price) || price <= 0) continue
  const key = `${A}/${B}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key)!.push({ dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('/') : ''), liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, price })
}

console.log(`\nStablecoin pairs on NEAR (pools with >= $${MIN_LIQ.toLocaleString()} liquidity)\n`)
const leads: string[] = []
for (const [key, rows] of [...groups].sort()) {
  const deep = rows.filter((r) => r.liq >= MIN_LIQ).sort((x, y) => y.liq - x.liq)
  if (!deep.length) continue
  console.log(`=== ${key}`)
  for (const r of deep) console.log(`   ${r.dex.padEnd(18)} liq $${Math.round(r.liq).toLocaleString().padStart(12)}  24h vol $${Math.round(r.vol).toLocaleString().padStart(12)}  price ${r.price.toFixed(6)}`)
  const offPeg = Math.max(...deep.map((r) => Math.abs(r.price - 1) * 1e4))
  if (deep.length >= 2) {
    const lo = deep.reduce((m, r) => (r.price < m.price ? r : m)), hi = deep.reduce((m, r) => (r.price > m.price ? r : m))
    const gap = (hi.price / lo.price - 1) * 1e4
    console.log(`   gap ${gap.toFixed(1)} bps between pools  (buy on ${lo.dex}, sell on ${hi.dex})`)
    if (gap >= 10) leads.push(`${key}: ${gap.toFixed(1)} bps between ${lo.dex} and ${hi.dex}`)
  } else console.log(`   only one deep pool; ${offPeg.toFixed(1)} bps from 1:1`)
}
console.log('\nLeads (>= 10 bps between deep pools):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
