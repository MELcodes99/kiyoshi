// Read-only: Stellar SDEX order book vs built-in AMM pools, FX/stablecoins against USDC. No wallet, no transactions.
const H = 'https://horizon.stellar.org'
const USDC = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }
const CODES = ['EURC', 'EURT', 'ARST', 'ARS', 'BRL', 'BRZ', 'BRLT', 'NGNC', 'NGN', 'KES', 'KESC', 'MXN', 'MXNC', 'GHSC', 'ZAR', 'PEN', 'COP', 'PHP', 'UGX', 'TZS', 'PYUSD', 'USDX', 'yUSDC']
const get = async (path: string) => (await fetch(H + path)).json()
const type = (code: string) => (code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12')
const q = (prefix: string, a: { code: string; issuer: string }) => `${prefix}_asset_type=${type(a.code)}&${prefix}_asset_code=${a.code}&${prefix}_asset_issuer=${a.issuer}`

console.log('Pair            Holders   Book bid / ask (USDC)        Book depth        Pool price   Pool USDC     Best gap after fee')
const leads: string[] = []
for (const code of CODES) {
  // Pick the issuer with the most holders (the "real" anchor for that code)
  const a: any = await get(`/assets?asset_code=${code}&limit=200`)
  const recs: any[] = a?._embedded?.records ?? []
  if (!recs.length) continue
  const top = recs.sort((x, y) => (y.accounts?.authorized ?? y.num_accounts ?? 0) - (x.accounts?.authorized ?? x.num_accounts ?? 0))[0]
  const X = { code, issuer: top.asset_issuer }
  const holders = top.accounts?.authorized ?? top.num_accounts ?? 0

  const ob: any = await get(`/order_book?${q('selling', X)}&${q('buying', USDC)}&limit=5`)
  const bid = Number(ob?.bids?.[0]?.price), ask = Number(ob?.asks?.[0]?.price)
  const bidDepth = (ob?.bids ?? []).reduce((s: number, o: any) => s + Number(o.amount), 0) // in USDC
  const askDepth = (ob?.asks ?? []).reduce((s: number, o: any) => s + Number(o.amount) * Number(o.price), 0)

  const lp: any = await get(`/liquidity_pools?reserves=${X.code}:${X.issuer},${USDC.code}:${USDC.issuer}`)
  const pool = lp?._embedded?.records?.[0]
  let poolPx = NaN, poolUsdc = 0, fee = 30
  if (pool) {
    const rx = Number(pool.reserves.find((r: any) => r.asset.startsWith(code + ':')).amount)
    poolUsdc = Number(pool.reserves.find((r: any) => r.asset.startsWith('USDC:')).amount)
    poolPx = poolUsdc / rx
    fee = pool.fee_bp
  }

  const f = 1 - fee / 1e4
  const g1 = bid > 0 && poolPx > 0 ? (bid / (poolPx / f) - 1) * 1e4 : NaN // buy from pool, sell to book bid
  const g2 = ask > 0 && poolPx > 0 ? ((poolPx * f) / ask - 1) * 1e4 : NaN // buy at book ask, sell to pool
  const best = Math.max(isNaN(g1) ? -Infinity : g1, isNaN(g2) ? -Infinity : g2)
  const fmt = (n: number, d = 6) => (isFinite(n) && n > 0 ? n.toFixed(d) : '-')
  console.log(`${(code + '/USDC').padEnd(14)} ${String(holders).padStart(8)}   ${fmt(bid).padStart(10)} / ${fmt(ask).padEnd(10)}  $${Math.round(bidDepth)}/$${Math.round(askDepth)}`.padEnd(90) +
    `${fmt(poolPx).padStart(10)}   $${Math.round(poolUsdc).toLocaleString().padStart(9)}   ${isFinite(best) ? best.toFixed(1) + ' bps' : 'n/a (missing book or pool)'}`)
  if (isFinite(best) && best >= 10 && poolUsdc >= 2000) leads.push(`${code}/USDC: ${best.toFixed(1)} bps (${g1 > g2 ? 'buy pool, sell book' : 'buy book, sell pool'}), pool $${Math.round(poolUsdc)} USDC`)
}
console.log('\nLeads (>= 10 bps after the pool fee, pool with >= $2k USDC):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
