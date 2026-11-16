// Read-only: FX stablecoin pools on Arc across DEXes (via DexScreener). No wallet, no transactions.
const SYMBOLS = ['wBRL', 'BRLA', 'wARS', 'wMXN', 'MXNB', 'ZARU', 'EURC', 'JPYC', 'GBPA', 'CADD', 'QCAD', 'TRYB', 'wCOP', 'wCLP', 'wPEN', 'AUDD', 'KRW1', 'CHFAU', 'EURAU', 'SEKAU']
const MIN_LIQ = Number(process.env.MIN_LIQ ?? 5000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chains = new Set<string>()
const leads: string[] = []

for (const sym of SYMBOLS) {
  const r: any = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`)).json().catch(() => ({}))
  await sleep(400)
  for (const p of r.pairs ?? []) chains.add(p.chainId)
  const rows = (r.pairs ?? [])
    .filter((p: any) => /arc/i.test(p.chainId))
    .map((p: any) => {
      const isBase = p.baseToken.symbol.toLowerCase() === sym.toLowerCase()
      const isQuote = p.quoteToken.symbol.toLowerCase() === sym.toLowerCase()
      if (!isBase && !isQuote) return null
      const price = isBase ? Number(p.priceUsd) : Number(p.priceUsd) / Number(p.priceNative)
      return { dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('/') : ''), vs: isBase ? p.quoteToken.symbol : p.baseToken.symbol, liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, price }
    })
    .filter(Boolean) as any[]
  if (!rows.length) { console.log(`${sym.padEnd(7)} no Arc pools`); continue }
  console.log(`\n=== ${sym} on Arc: ${rows.length} pools`)
  for (const x of rows.sort((a, b) => b.liq - a.liq).slice(0, 6))
    console.log(`   ${x.dex.padEnd(16)} vs ${x.vs.padEnd(6)} liq $${Math.round(x.liq).toLocaleString().padStart(10)}  24h vol $${Math.round(x.vol).toLocaleString().padStart(9)}  USD price ${x.price.toPrecision(6)}`)
  const deep = rows.filter((x) => x.liq >= MIN_LIQ && isFinite(x.price) && x.price > 0)
  if (deep.length >= 2) {
    const lo = deep.reduce((m, x) => (x.price < m.price ? x : m)), hi = deep.reduce((m, x) => (x.price > m.price ? x : m))
    const gap = (hi.price / lo.price - 1) * 1e4
    console.log(`   gap ${gap.toFixed(1)} bps between deep pools (cheapest ${lo.dex}/${lo.vs}, priciest ${hi.dex}/${hi.vs})`)
    if (gap >= 20) leads.push(`${sym}: ${gap.toFixed(1)} bps between ${lo.dex} and ${hi.dex}`)
  }
}
console.log(`\nChains DexScreener returned: ${[...chains].sort().join(', ')}`)
console.log('\nLeads (>= 20 bps between pools with >= $' + MIN_LIQ.toLocaleString() + '):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
