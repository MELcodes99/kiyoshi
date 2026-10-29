// Read-only: compare every Textile pair's price with Celo DEX pools. No transactions.
const tickers: any[] = await (await fetch('https://api.textilecredit.com/tickers')).json()
const ALIAS: Record<string, string[]> = { NGN: ['cNGN'], IDR: ['IDRX'], BRL: ['BRLA', 'wBRL'], ZARU: ['ZARU', 'ZARP'], MXN: ['MXNB', 'MXNe', 'MXN'], COP: ['COPM', 'COPm', 'wCOP'], CELO: ['CELO'], WETH: ['WETH'], GD: ['GD'], USAT: ['USAT'], TESOURO: ['TESOURO'], WARS: ['wARS'], WBRL: ['wBRL'] }
const USDLIKE = /^(USD₮|USDT|USDC|USDm|cUSD|USDGLO)$/i

for (const t of tickers) {
  const baseIsUsd = USDLIKE.test(t.base_currency)
  const asset = baseIsUsd ? t.target_currency : t.base_currency
  if (USDLIKE.test(asset)) continue
  // Textile price expressed as USD per 1 asset
  const bid = Number(t.bid), ask = Number(t.ask), last = Number(t.last_price)
  const tx = (x: number) => (x > 0 ? (baseIsUsd ? 1 / x : x) : NaN)
  const txMid = bid > 0 && ask > 0 ? (tx(bid) + tx(ask)) / 2 : tx(last)

  const pools: any[] = []
  for (const q of ALIAS[asset.toUpperCase()] ?? [asset]) {
    const r: any = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`)).json()
    pools.push(...(r.pairs ?? []).filter((p: any) => p.chainId === 'celo'))
  }
  const seen = new Set<string>()
  const rows = pools.filter(p => !seen.has(p.pairAddress) && seen.add(p.pairAddress))
    .map(p => {
      const names = (ALIAS[asset.toUpperCase()] ?? [asset]).map(s => s.toLowerCase())
      const isBase = names.includes(p.baseToken.symbol.toLowerCase())
      const isQuote = names.includes(p.quoteToken.symbol.toLowerCase())
      if (!isBase && !isQuote) return null
      const price = isBase ? Number(p.priceUsd) : Number(p.priceUsd) / Number(p.priceNative)
      return { dex: p.dexId, sym: isBase ? p.baseToken.symbol : p.quoteToken.symbol, addr: isBase ? p.baseToken.address : p.quoteToken.address, vs: isBase ? p.quoteToken.symbol : p.baseToken.symbol, liq: p.liquidity?.usd ?? 0, price }
    }).filter(Boolean).sort((a: any, b: any) => b.liq - a.liq) as any[]

  console.log(`\n=== ${t.ticker_id}  Textile mid $${txMid.toPrecision(6)}  (bid ${t.bid} / ask ${t.ask}, 24h vol ${t.base_volume} ${t.base_currency})`)
  if (!rows.length) { console.log('   no Celo DEX pool found'); continue }
  for (const r of rows.slice(0, 4)) {
    const gap = isFinite(txMid) && r.price > 0 ? ((r.price / txMid - 1) * 1e4).toFixed(0) + ' bps' : 'n/a'
    console.log(`   ${r.dex.padEnd(11)} ${r.sym.padEnd(8)} vs ${r.vs.padEnd(6)} liq $${Math.round(r.liq).toLocaleString().padStart(10)}  pool $${r.price.toPrecision(6)}  gap ${gap.padStart(8)}  ${r.addr}`)
  }
}
