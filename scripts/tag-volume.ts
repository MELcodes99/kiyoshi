// Read-only: all Celo volume carrying our attribution tag, from every wallet. No key needed.
import { toDataSuffix } from '@celo/attribution-tags'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ATTRIBUTION_TAG, TEXTILE_REACTOR, TOKENS, UNI } from '../src/config.js'

const API = 'https://celo.blockscout.com/api'
const SUFFIX = String(toDataSuffix(ATTRIBUTION_TAG)).slice(2).toLowerCase()
const START_BLOCK = Number(process.env.START_BLOCK ?? 81_000_000)
const USDT = TOKENS.USDT.address.toLowerCase()
const REACTOR = TEXTILE_REACTOR.toLowerCase()
const ROUTER = UNI.ROUTER.toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Fetch every row, retrying when the explorer rate-limits or errors
async function all(params: string): Promise<any[]> {
  const out: any[] = [], seen = new Set<string>()
  let start = START_BLOCK
  for (;;) {
    let rows: any[] | null = null
    for (let attempt = 0; attempt < 15 && rows === null; attempt++) {
      const j: any = await fetch(`${API}?${params}&startblock=${start}&sort=asc&page=1&offset=1000`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}))
      if (Array.isArray(j.result)) rows = j.result
      else if (j.status === '0' && /no (transactions|token transfers) found/i.test(String(j.message))) rows = []
      else { if (attempt % 3 === 2) console.log(`\n  explorer says: ${j.message ?? j.result ?? 'no response'}, retrying...`); await sleep(Math.min(3000 * (attempt + 1), 30_000)) }
    }
    if (rows === null) throw new Error(`explorer kept failing for ${params}`)
    for (const r of rows) { const k = r.hash + ':' + (r.logIndex ?? r.transactionIndex ?? ''); if (!seen.has(k)) { seen.add(k); out.push(r) } }
    if (rows.length < 1000) return out
    start = Number(rows[rows.length - 1].blockNumber)
    process.stdout.write('.')
    await sleep(300)
  }
}
const tagged = (r: any) => String(r.input ?? '').toLowerCase().endsWith(SUFFIX) && r.isError === '0'

console.log(`Tag ${ATTRIBUTION_TAG}: scanning Textile settlement contract from block ${START_BLOCK}...`)
const CACHE = 'tag-volume-cache.json'
let reactorTxs: any[]
if (existsSync(CACHE) && !process.env.FRESH) {
  reactorTxs = JSON.parse(readFileSync(CACHE, 'utf8'))
  console.log(`Loaded ${reactorTxs.length} tagged fills from ${CACHE} (run with FRESH=1 to rescan)`)
} else {
  reactorTxs = (await all(`module=account&action=txlist&address=${REACTOR}`)).filter((r) => r.to?.toLowerCase() === REACTOR && tagged(r))
  writeFileSync(CACHE, JSON.stringify(reactorTxs))
}
const byWallet = new Map<string, any[]>()
for (const r of reactorTxs) { const w = r.from.toLowerCase(); if (!byWallet.has(w)) byWallet.set(w, []); byWallet.get(w)!.push(r) }
console.log(`\nFound ${reactorTxs.length} tagged Textile fills from ${byWallet.size} wallet(s)\n`)

const totals = { textileN: 0, textileUsd: 0, uniN: 0, uniUsd: 0 }
const $ = (n: number) => ('$' + Math.round(n).toLocaleString()).padStart(11)
console.log('Wallet                                       Textile fills   Textile vol    Uni swaps     Uni vol      Total vol    First fill   Last fill')
for (const [w, tex] of [...byWallet].sort((a, b) => b[1].length - a[1].length)) {
  const transfers = await all(`module=account&action=tokentx&address=${w}&contractaddress=${USDT}`)
  await sleep(500)
  const txs = await all(`module=account&action=txlist&address=${w}`)
  await sleep(500)
  // Largest USDT transfer per tx involving this wallet = the trade leg (ignores tiny gas-fee debits)
  const leg = new Map<string, number>()
  for (const t of transfers) {
    const other = t.from.toLowerCase() === w ? t.to.toLowerCase() : t.from.toLowerCase()
    if (other === ZERO) continue
    leg.set(t.hash, Math.max(leg.get(t.hash) ?? 0, Number(t.value) / 1e6))
  }
  const uni = txs.filter((r) => r.from.toLowerCase() === w && r.to?.toLowerCase() === ROUTER && tagged(r))
  const texUsd = tex.reduce((s, r) => s + (leg.get(r.hash) ?? 0), 0)
  const uniUsd = uni.reduce((s, r) => s + (leg.get(r.hash) ?? 0), 0)
  totals.textileN += tex.length; totals.textileUsd += texUsd; totals.uniN += uni.length; totals.uniUsd += uniUsd
  const day = (r: any) => new Date(Number(r.timeStamp) * 1000).toISOString().slice(0, 10)
  console.log(`${w}   ${String(tex.length).padStart(8)}   ${$(texUsd)}   ${String(uni.length).padStart(8)}   ${$(uniUsd)}   ${$(texUsd + uniUsd)}    ${day(tex[0])}   ${day(tex[tex.length - 1])}`)
}
console.log('\nTOTAL across all wallets using the tag:')
console.log(`  Textile: ${totals.textileN} fills, $${Math.round(totals.textileUsd).toLocaleString()}`)
console.log(`  Uniswap: ${totals.uniN} swaps, $${Math.round(totals.uniUsd).toLocaleString()}`)
console.log(`  ALL:     $${Math.round(totals.textileUsd + totals.uniUsd).toLocaleString()}`)
