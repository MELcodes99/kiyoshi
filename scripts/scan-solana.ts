// Read-only: Solana stablecoin round trips via Jupiter (all DEXes + market-maker RFQ). No wallet, no transactions.
const J = 'https://lite-api.jup.ag'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SYMBOLS = ['USDT', 'PYUSD', 'USDG', 'USD1', 'USDS', 'FDUSD', 'AUSD', 'EURC', 'VEUR', 'BRZ', 'MXNe', 'ZARP', 'GYEN', 'XSGD']
const SIZES = [100, 1000, 5000]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function get(url: string): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url).catch(() => null)
    if (r?.ok) return r.json()
    await sleep(2000 * (i + 1))
  }
  return null
}

const leads: string[] = []
for (const sym of SYMBOLS) {
  // Find the verified token with the most liquidity for this symbol
  const found: any[] = (await get(`${J}/tokens/v2/search?query=${sym}`)) ?? []
  await sleep(1100)
  const tok = found
    .filter((t) => String(t.symbol).toLowerCase() === sym.toLowerCase() && (t.isVerified || (t.tags ?? []).includes('verified')))
    .sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0))[0]
  if (!tok) { console.log(`\n${sym}: no verified token found`); continue }
  console.log(`\n${sym}  ${tok.id}  price $${Number(tok.usdPrice ?? 0).toFixed(4)}  liquidity $${Math.round(tok.liquidity ?? 0).toLocaleString()}`)

  for (const usd of SIZES) {
    const amt = usd * 1e6
    const q1 = await get(`${J}/swap/v1/quote?inputMint=${USDC}&outputMint=${tok.id}&amount=${amt}&slippageBps=50`)
    await sleep(1100)
    if (!q1?.outAmount) { console.log(`   $${usd}: no route`); continue }
    const q2 = await get(`${J}/swap/v1/quote?inputMint=${tok.id}&outputMint=${USDC}&amount=${q1.outAmount}&slippageBps=50`)
    await sleep(1100)
    if (!q2?.outAmount) { console.log(`   $${usd}: no route back`); continue }
    const back = Number(q2.outAmount) / 1e6
    const bps = (back / usd - 1) * 1e4
    const via = (q: any) => [...new Set((q.routePlan ?? []).map((s: any) => s.swapInfo?.label).filter(Boolean))].join('+')
    console.log(`   $${String(usd).padStart(5)}: ${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps ($${(back - usd).toFixed(3)})   buy via ${via(q1) || '?'} | sell via ${via(q2) || '?'}`)
    if (bps > 0) leads.push(`${sym} at $${usd}: +${bps.toFixed(1)} bps (+$${(back - usd).toFixed(3)}), buy ${via(q1)}, sell ${via(q2)}`)
  }
}
console.log('\nPositive round trips (a real cross-venue gap after all fees):')
console.log(leads.length ? leads.map((l) => '  ' + l).join('\n') : '  none right now')
