// Compare Kiyoshi's own per-cycle P&L with the explorer's USDT transfers for the same txs.
const KEY = process.env.BLOCKSCOUT_API_KEY
const API = KEY ? `https://api.blockscout.com/v2/api?chain_id=42220&apikey=${KEY}&` : 'https://celo.blockscout.com/api?'
const W = '0x497f12830607015ed5ec9736afe43aaf8496512f'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const trades: any[] = await (await fetch('https://kiyoshi-oz4x.onrender.com/trades?limit=40')).json()
const cycles = trades.filter((t) => t.event === 'cycle' && typeof t.pnl === 'number' && t.tx1 && t.tx2).slice(0, 15)
console.log(`${cycles.length} recent completed cycles\n`)
for (const c of cycles) {
  let line = `${c.ts.slice(5, 16)} ${String(c.X ?? '').padEnd(5)} ${c.route.padEnd(13)} ledger ${c.pnl >= 0 ? '+' : ''}${c.pnl.toFixed(4)} | `
  let sum = 0
  for (const h of [c.tx1, c.tx2]) {
    const j: any = await (await fetch(`${API}module=account&action=tokentx&address=${W}&contractaddress=${USDT}&txhash=${h}`)).json().catch(() => ({}))
    const rows = (Array.isArray(j.result) ? j.result : []).filter((t: any) => t.hash.toLowerCase() === h.toLowerCase())
    const parts = rows.map((t: any) => {
      const inc = t.to.toLowerCase() === W
      const v = Number(t.value) / 1e6
      if ((inc ? t.from : t.to).toLowerCase() !== '0x0000000000000000000000000000000000000000') sum += inc ? v : -v
      return `${inc ? '+' : '-'}${v.toFixed(4)}(${(inc ? t.from : t.to).slice(0, 8)})`
    })
    line += `${h.slice(0, 8)}: ${parts.join(' ') || 'NO USDT TRANSFERS FOUND'}  `
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(line + `| explorer net ${sum >= 0 ? '+' : ''}${sum.toFixed(4)}`)
}
