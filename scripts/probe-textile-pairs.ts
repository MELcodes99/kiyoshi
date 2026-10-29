import { TEXTILE_API } from '../src/config.js'
import { getTicker } from '../src/textile.js'
console.log('TEXTILE_API =', TEXTILE_API)
console.log('getTicker source:\n' + getTicker.toString().slice(0, 600) + '\n')
const base = TEXTILE_API.replace(/\/$/, '')
const roots = [base, base.replace(/\/v\d+$/, ''), base + '/coingecko', base.replace(/\/v\d+$/, '') + '/coingecko']
for (const r of [...new Set(roots)]) for (const p of ['/pairs', '/tickers', '/tokens', '/assets', '/currencies', '/markets']) {
  try {
    const res = await fetch(r + p)
    const t = await res.text()
    if (res.ok) console.log(`OK ${r + p}\n${t.slice(0, 1200)}\n`)
    else console.log(`${res.status} ${r + p}`)
  } catch (e: any) { console.log(`ERR ${r + p} ${e.message}`) }
}
