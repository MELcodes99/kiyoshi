// Read-only: Textile cNGN quotes on Base vs the Uniswap v4 cNGN/USDC pool price. No transactions.
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'

const pairs: any[] = await (await fetch(`https://api.dexscreener.com/tokens/v1/base/${CNGN}`)).json()
const pool = pairs.filter((p) => p.dexId === 'uniswap').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
if (!pool) { console.log('no Uniswap pool found'); process.exit(0) }
// pool price as cNGN per 1 USDC
const native = Number(pool.priceNative)
const poolNgnPerUsd = pool.baseToken.address.toLowerCase() === CNGN.toLowerCase() ? 1 / native : native
console.log(`Uniswap v4 pool: ${poolNgnPerUsd.toFixed(2)} cNGN per USDC  (liq $${Math.round(pool.liquidity.usd).toLocaleString()}, fee tier ${pool.labels?.join('/') ?? '?'})\n`)

async function preview(sell: string, buy: string, amt: bigint) {
  const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId: 8453, sellToken: sell, buyToken: buy, sellAmount: amt.toString() }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return `HTTP ${r.status}`
  return j.data?.status === 'preview' ? BigInt(j.data.buyAmount) : `no quote (${j.data?.reason})`
}

for (const usd of [20, 100, 500]) {
  // Textile sells cNGN to us (we pay USDC)
  const buy = await preview(USDC, CNGN, BigInt(usd * 1e6))
  const texBuyRate = typeof buy === 'bigint' ? Number(buy) / 1e6 / usd : NaN // cNGN we get per USDC
  // Textile buys cNGN from us (we receive USDC)
  const ngnAmt = BigInt(Math.round(usd * poolNgnPerUsd * 1e6))
  const sell = await preview(CNGN, USDC, ngnAmt)
  const texSellRate = typeof sell === 'bigint' ? (usd * poolNgnPerUsd) / (Number(sell) / 1e6) : NaN // cNGN we give per USDC

  // Route 1: buy cNGN on Textile, sell into pool. Profit if Textile gives MORE cNGN per $ than the pool price.
  const r1 = isFinite(texBuyRate) ? (texBuyRate / poolNgnPerUsd - 1) * 1e4 : NaN
  // Route 2: buy cNGN in pool, sell to Textile. Profit if Textile takes FEWER cNGN per $ than the pool price.
  const r2 = isFinite(texSellRate) ? (poolNgnPerUsd / texSellRate - 1) * 1e4 : NaN
  console.log(`$${String(usd).padStart(3)}  Textile buy ${isFinite(texBuyRate) ? texBuyRate.toFixed(2) : String(buy)}  sell ${isFinite(texSellRate) ? texSellRate.toFixed(2) : String(sell)}   ` +
    `Textile->pool ${isFinite(r1) ? r1.toFixed(1) + ' bps' : 'n/a'}   pool->Textile ${isFinite(r2) ? r2.toFixed(1) + ' bps' : 'n/a'}   (before pool fee and price impact)`)
}
