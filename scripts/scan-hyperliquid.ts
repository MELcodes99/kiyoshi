// Read-only: stablecoin pairs on Hyperliquid's order book (HyperCore) vs HyperEVM DEX pools. No wallet, no transactions.
const API = 'https://api.hyperliquid.xyz/info'
const STABLE = /^(USDT0|USDE|USDH|USDHL|FEUSD|USDXL|USDT|USR|USD0|USDC)$/i
const post = async (body: any) => (await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

const [meta, ctxs]: any = await post({ type: 'spotMetaAndAssetCtxs' })
const tok = (i: number) => meta.tokens[i]?.name as string

console.log('=== HyperCore order book (stable vs stable)\n')
const core: Record<string, { bid: number; ask: number; mid: number; quote: string }> = {}
for (const [i, u] of meta.universe.entries()) {
  const [b, q] = u.tokens.map(tok)
  if (!STABLE.test(b) || !STABLE.test(q)) continue
  const book: any = await post({ type: 'l2Book', coin: u.name })
  const bid = Number(book?.levels?.[0]?.[0]?.px), ask = Number(book?.levels?.[1]?.[0]?.px)
  const bidSz = Number(book?.levels?.[0]?.[0]?.sz), askSz = Number(book?.levels?.[1]?.[0]?.sz)
  const mid = (bid + ask) / 2
  const vol = Number(ctxs[i]?.dayNtlVlm ?? 0)
  core[b.toUpperCase()] = { bid, ask, mid, quote: q }
  console.log(`${(b + '/' + q).padEnd(14)} bid ${bid.toFixed(5)} (${Math.round(bidSz).toLocaleString()})  ask ${ask.toFixed(5)} (${Math.round(askSz).toLocaleString()})  spread ${((ask / bid - 1) * 1e4).toFixed(1)} bps  24h vol $${Math.round(vol).toLocaleString()}`)
}

console.log('\n=== HyperEVM DEX pools vs the order book\n')
const leads: string[] = []
for (const sym of Object.keys(core)) {
  const r: any = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`)).json()
  const pools = (r.pairs ?? []).filter((p: any) => p.chainId === 'hyperevm' && (p.liquidity?.usd ?? 0) >= 10_000)
    .filter((p: any) => [p.baseToken.symbol, p.quoteToken.symbol].some((s: string) => s.toUpperCase() === sym))
  const c = core[sym]
  if (!pools.length) { console.log(`${sym.padEnd(7)} no HyperEVM pool with >= $10k`); continue }
  for (const p of pools) {
    const isBase = p.baseToken.symbol.toUpperCase() === sym
    const px = isBase ? Number(p.priceUsd) : Number(p.priceUsd) / Number(p.priceNative)
    // Gap after crossing the book: buy on the cheaper side, sell on the other
    const buyPoolSellBook = (c.bid / px - 1) * 1e4
    const buyBookSellPool = (px / c.ask - 1) * 1e4
    const best = Math.max(buyPoolSellBook, buyBookSellPool)
    console.log(`${sym.padEnd(7)} ${p.dexId.padEnd(12)} vs ${(isBase ? p.quoteToken.symbol : p.baseToken.symbol).padEnd(6)} liq $${Math.round(p.liquidity.usd).toLocaleString().padStart(10)}  pool $${px.toFixed(5)}  book ${c.bid.toFixed(5)}/${c.ask.toFixed(5)}  best gap ${best.toFixed(1)} bps`)
    if (best >= 10) leads.push(`${sym}: ${best.toFixed(1)} bps (${buyPoolSellBook > buyBookSellPool ? 'buy pool, sell book' : 'buy book, sell pool'}) on ${p.dexId}`)
  }
}
console.log('\nLeads (>= 10 bps after crossing the book spread):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
