// Read-only: every Celo pool for our corridor tokens, across all DEXes and quote coins. No transactions.
const TOKENS: Record<string, string> = {
  wBRL: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0',
  wARS: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D',
  cNGN: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f',
}
const MIN_LIQ = Number(process.env.MIN_LIQ ?? 2000) // ignore pools thinner than this (USD)

const res = await fetch(`https://api.dexscreener.com/tokens/v1/celo/${Object.values(TOKENS).join(',')}`)
const pairs: any[] = await res.json()

for (const [sym, addr] of Object.entries(TOKENS)) {
  const a = addr.toLowerCase()
  const rows = pairs
    .filter(p => p.baseToken.address.toLowerCase() === a || p.quoteToken.address.toLowerCase() === a)
    .map(p => {
      const isBase = p.baseToken.address.toLowerCase() === a
      const other = isBase ? p.quoteToken.symbol : p.baseToken.symbol
      const usd = Number(p.priceUsd), nat = Number(p.priceNative)
      const price = isBase ? usd : (nat > 0 ? usd / nat : NaN) // USD per 1 token
      return { dex: `${p.dexId}${p.labels?.length ? ' ' + p.labels.join('/') : ''}`, other, liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, price, pair: p.pairAddress }
    })
    .sort((x, y) => y.liq - x.liq)

  console.log(`\n=== ${sym}: ${rows.length} pools ===`)
  console.log('DEX                  vs      Liquidity     24h vol    USD price      Pair')
  for (const r of rows)
    console.log(`${r.dex.padEnd(20)} ${r.other.padEnd(6)} $${Math.round(r.liq).toLocaleString().padStart(10)} $${Math.round(r.vol).toLocaleString().padStart(10)}   ${r.price.toPrecision(6).padStart(10)}   ${r.pair}`)

  const deep = rows.filter(r => r.liq >= MIN_LIQ && isFinite(r.price))
  if (deep.length >= 2) {
    const lo = deep.reduce((m, r) => (r.price < m.price ? r : m)), hi = deep.reduce((m, r) => (r.price > m.price ? r : m))
    console.log(`Gap across pools >= $${MIN_LIQ}: ${((hi.price / lo.price - 1) * 1e4).toFixed(1)} bps  (cheapest ${lo.dex}/${lo.other}, priciest ${hi.dex}/${hi.other})`)
  } else console.log(`Only ${deep.length} pool(s) with >= $${MIN_LIQ} liquidity: no cross-DEX trade possible.`)
}
