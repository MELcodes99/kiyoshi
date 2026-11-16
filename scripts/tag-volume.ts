// Read-only: volume and trading profit for every Celo wallet carrying our attribution tag. No key needed.
import { toDataSuffix } from '@celo/attribution-tags'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ATTRIBUTION_TAG, TEXTILE_REACTOR, TOKENS, UNI } from '../src/config.js'

const KEY = process.env.BLOCKSCOUT_API_KEY
const API = KEY ? 'https://api.blockscout.com/v2/api' : 'https://celo.blockscout.com/api'
const KEYQ = KEY ? `chain_id=42220&apikey=${KEY}&` : ''
const SUFFIX = String(toDataSuffix(ATTRIBUTION_TAG)).slice(2).toLowerCase()
const START_BLOCK = Number(process.env.START_BLOCK ?? 81_000_000)
const USDT = TOKENS.USDT.address.toLowerCase()
const REACTOR = TEXTILE_REACTOR.toLowerCase()
const ROUTER = UNI.ROUTER.toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function all(params: string): Promise<any[]> {
  const out: any[] = [], seen = new Set<string>()
  let start = START_BLOCK
  for (;;) {
    let rows: any[] | null = null
    for (let attempt = 0; attempt < 15 && rows === null; attempt++) {
      const j: any = await fetch(`${API}?${KEYQ}${params}&startblock=${start}&sort=asc&page=1&offset=1000`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}))
      if (Array.isArray(j.result)) rows = j.result
      else if (j.status === '0' && /no (transactions|token transfers) found/i.test(String(j.message))) rows = []
      else { if (attempt % 3 === 2) console.log(`\n  explorer says: ${j.message ?? j.result ?? 'no response'}, retrying...`); await sleep(Math.min(3000 * (attempt + 1), 30_000)) }
    }
    if (rows === null) throw new Error(`explorer kept failing for ${params}`)
    for (const r of rows) { const k = r.hash + ':' + (r.logIndex ?? r.transactionIndex ?? ''); if (!seen.has(k)) { seen.add(k); out.push(r) } }
    if (rows.length < 1000) return out
    start = Number(rows[rows.length - 1].blockNumber)
    process.stdout.write('.')
    await sleep(KEY ? 200 : 1500)
  }
}
const tagged = (r: any) => String(r.input ?? '').toLowerCase().endsWith(SUFFIX) && r.isError === '0'

console.log(`Tag ${ATTRIBUTION_TAG}`)
const CACHE = 'tag-volume-cache.json'
let reactorTxs: any[]
if (existsSync(CACHE) && !process.env.FRESH) {
  reactorTxs = JSON.parse(readFileSync(CACHE, 'utf8'))
  console.log(`Loaded ${reactorTxs.length} tagged fills from ${CACHE} (run with FRESH=1 to rescan)`)
} else {
  console.log(`Scanning Textile settlement contract from block ${START_BLOCK}...`)
  reactorTxs = (await all(`module=account&action=txlist&address=${REACTOR}`)).filter((r) => r.to?.toLowerCase() === REACTOR && tagged(r))
  writeFileSync(CACHE, JSON.stringify(reactorTxs))
}
const byWallet = new Map<string, any[]>()
for (const r of reactorTxs) { const w = r.from.toLowerCase(); if (!byWallet.has(w)) byWallet.set(w, []); byWallet.get(w)!.push(r) }
console.log(`${reactorTxs.length} tagged Textile fills from ${byWallet.size} wallet(s)\n`)

const $ = (n: number, w = 11) => ((n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString()).padStart(w)
const $2 = (n: number, w = 11) => ((n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2)).padStart(w)
const totals = { textileN: 0, textileUsd: 0, uniN: 0, uniUsd: 0, profit: 0 }
console.log('Wallet                                       Textile fills  Textile vol   Uni swaps     Uni vol   Total vol   Trading profit   First       Last')
for (const [w, tex] of [...byWallet].sort((a, b) => b[1].length - a[1].length)) {
  const transfers = await all(`module=account&action=tokentx&address=${w}&contractaddress=${USDT}`)
  await sleep(KEY ? 200 : 1000)
  const txs = await all(`module=account&action=txlist&address=${w}`)
  await sleep(KEY ? 200 : 1000)
  const leg = new Map<string, number>()  // largest USDT transfer per tx = the trade leg (volume)
  const flow = new Map<string, number>() // signed USDT in minus out per tx (profit)
  for (const t of transfers) {
    const incoming = t.to.toLowerCase() === w
    const other = incoming ? t.from.toLowerCase() : t.to.toLowerCase()
    if (other === ZERO) continue
    const v = Number(t.value) / 1e6
    leg.set(t.hash, Math.max(leg.get(t.hash) ?? 0, v))
    flow.set(t.hash, (flow.get(t.hash) ?? 0) + (incoming ? v : -v))
  }
  const uni = txs.filter((r) => r.from.toLowerCase() === w && r.to?.toLowerCase() === ROUTER && tagged(r))
  const texUsd = tex.reduce((s, r) => s + (leg.get(r.hash) ?? 0), 0)
  const uniUsd = uni.reduce((s, r) => s + (leg.get(r.hash) ?? 0), 0)
  const profit = [...tex, ...uni].reduce((s, r) => s + (flow.get(r.hash) ?? 0), 0)
  totals.textileN += tex.length; totals.textileUsd += texUsd; totals.uniN += uni.length; totals.uniUsd += uniUsd; totals.profit += profit
  const day = (r: any) => new Date(Number(r.timeStamp) * 1000).toISOString().slice(0, 10)
  console.log(`${w}   ${String(tex.length).padStart(8)}  ${$(texUsd)}  ${String(uni.length).padStart(8)}  ${$(uniUsd)}  ${$(texUsd + uniUsd)}   ${$2(profit, 13)}   ${day(tex[0])}  ${day(tex[tex.length - 1])}`)
}
console.log('\nTOTAL across all wallets using the tag:')
console.log(`  Textile:        ${totals.textileN} fills, $${Math.round(totals.textileUsd).toLocaleString()}`)
console.log(`  Uniswap:        ${totals.uniN} swaps, $${Math.round(totals.uniUsd).toLocaleString()}`)
console.log(`  Volume:         $${Math.round(totals.textileUsd + totals.uniUsd).toLocaleString()}`)
console.log(`  Trading profit: ${totals.profit >= 0 ? '+' : '-'}$${Math.abs(totals.profit).toFixed(2)}`)
console.log('\nTrading profit = USDT received minus USDT paid on tagged trades only (deposits and withdrawals excluded).')
console.log('It does not count tokens still held mid-trade, so it can differ slightly from a dashboard equity figure.')
