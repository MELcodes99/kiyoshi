// Read-only: stablecoin pools on any DexScreener chain, compared across DEXes. No wallet, no transactions.
// Usage: npx tsx scripts/scan-chain-stables.ts <chainId> [SYMBOL ...]
const [CHAIN, ...syms] = process.argv.slice(2)
if (!CHAIN) { console.log('usage: npx tsx scripts/scan-chain-stables.ts <chainId> [SYMBOL ...]'); process.exit(1) }
const SYMBOLS = syms.length ? syms : ['USDC', 'USDT', 'USDT0', 'USDC.e', 'USDe', 'USDa', 'FRAX', 'DAI', 'PYUSD', 'USD1', 'EURC', 'EURe']
const MIN_LIQ = Number(process.env.MIN_LIQ ?? 10000)
const STABLE = new Set(SYMBOLS.map((s) => s.toLowerCase()))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const pools = new Map<string, any>()
for (const sym of SYMBOLS) {
  const r: any = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`)).json().catch(() => ({}))
  for (const p of r.pairs ?? []) if (p.chainId === CHAIN) pools.set(p.pairAddress, p)
  await sleep(400)
}
console.log(`${pools.size} pools found on ${CHAIN} for these symbols\n`)

const groups = new Map<string, any[]>()
for (const p of pools.values()) {
  const a = p.baseToken.symbol, b = p.quoteToken.symbol
  if (!STABLE.has(a.toLowerCase()) || !STABLE.has(b.toLowerCase())) continue // stable vs stable only
  const [A, B] = [a, b].sort()
  const native = Number(p.priceNative)
  const price = a === A ? native : 1 / native
  if (!isFinite(price) || price <= 0) continue
  const key = `${A}/${B}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key)!.push({ dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('/') : ''), liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, price })
}
const leads: string[] = []
for (const [key, rows] of [...groups].sort()) {
  const deep = rows.filter((r) => r.liq >= MIN_LIQ).sort((x, y) => y.liq - x.liq)
  if (!deep.length) continue
  console.log(`=== ${key}`)
  for (const r of deep) console.log(`   ${r.dex.padEnd(18)} liq $${Math.round(r.liq).toLocaleString().padStart(12)}  24h vol $${Math.round(r.vol).toLocaleString().padStart(11)}  price ${r.price.toFixed(6)}`)
  if (deep.length >= 2) {
    const lo = deep.reduce((m, r) => (r.price < m.price ? r : m)), hi = deep.reduce((m, r) => (r.price > m.price ? r : m))
    const gap = (hi.price / lo.price - 1) * 1e4
    console.log(`   gap ${gap.toFixed(1)} bps (buy on ${lo.dex}, sell on ${hi.dex})`)
    if (gap >= 10) leads.push(`${key}: ${gap.toFixed(1)} bps between ${lo.dex} and ${hi.dex}`)
  } else console.log(`   only one deep pool; ${(Math.abs(deep[0].price - 1) * 1e4).toFixed(1)} bps from 1:1`)
}
if (!groups.size) console.log('No stable-vs-stable pools found on this chain.')
console.log('\nLeads (>= 10 bps between deep pools):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
