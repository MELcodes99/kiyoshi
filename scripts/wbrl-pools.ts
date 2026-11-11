const WBRL = '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'
for (const chain of ['celo', 'ethereum', 'base', 'polygon', 'bsc', 'arbitrum']) {
  const pairs: any[] = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/${chain}/${WBRL}`)).json().catch(() => [])
  if (!Array.isArray(pairs) || !pairs.length) { console.log(`${chain.padEnd(9)} no wBRL pools`); continue }
  console.log(`${chain}:`)
  for (const p of pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)))
    console.log(`   ${(p.dexId + ' ' + (p.labels?.join('/') ?? '')).padEnd(16)} ${p.baseToken.symbol}/${p.quoteToken.symbol}`.padEnd(36) + `liq $${Math.round(p.liquidity?.usd ?? 0).toLocaleString().padStart(10)}  24h vol $${Math.round(p.volume?.h24 ?? 0).toLocaleString().padStart(9)}  id ${p.pairAddress}`)
}
