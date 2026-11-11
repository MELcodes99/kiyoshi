const T: Record<string, string> = {
  cNGN: '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F',
  ZARU: '0xE205b4e7Ac03E3f7b2060C3EDf2171AA7126C0d5',
  TESOURO: '0x7ceE47e7B7CD04CF984e8Dd86C42595B5771A9B2',
}
const pairs: any[] = await (await fetch(`https://api.dexscreener.com/tokens/v1/base/${Object.values(T).join(',')}`)).json()
for (const [sym, addr] of Object.entries(T)) {
  const mine = pairs.filter((p) => [p.baseToken.address, p.quoteToken.address].some((a: string) => a.toLowerCase() === addr.toLowerCase()))
  console.log(`\n=== ${sym}: ${mine.length} pools on Base`)
  for (const p of mine.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)))
    console.log(`   ${(p.dexId + (p.labels?.length ? ' ' + p.labels.join('/') : '')).padEnd(18)} ${p.baseToken.symbol}/${p.quoteToken.symbol}`.padEnd(40) + `liq $${Math.round(p.liquidity?.usd ?? 0).toLocaleString().padStart(10)}  24h vol $${Math.round(p.volume?.h24 ?? 0).toLocaleString()}`)
}
