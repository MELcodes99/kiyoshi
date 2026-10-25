// Naira Desk trading loop. Dry run by default; LIVE=1 trades real money.
// Set PORT to also serve /health, /status and /trades (for Render and the dashboard).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { formatUnits, parseUnits } from 'viem'
import { ATTRIBUTION_TAG, CORRIDORS, TOKENS, type TokenKey } from './config.js'
import { account, pub, lastTxBlock } from './wallet.js'
import { balanceOf, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuote, uniSwap } from './uniswap.js'

const LIVE = process.env.LIVE === '1'
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? '20')
const MIN_EDGE_USD = Number(process.env.MIN_EDGE_USD ?? '0.01')
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '60') * 1000
const PORT = Number(process.env.PORT ?? 0)
const ONCE = process.env.ONCE === '1'
const SLIPPAGE_BPS = 30n // 0.3%
const AGENT_ID = 9991
const TRADES_FILE = 'trades.jsonl'
const STATE_FILE = 'state.json'

const usd = (v: bigint) => Number(formatUnits(v, 6))
const amt = (k: TokenKey, v: bigint) => Number(formatUnits(v, TOKENS[k].decimals))
const withSlippage = (v: bigint) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- ledger ----------
type Entry = Record<string, any>
const fills: Entry[] = [] // cycles and flattens (no scans), served at /trades
if (existsSync(TRADES_FILE)) {
  for (const line of readFileSync(TRADES_FILE, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e.event === 'cycle' || e.event === 'flatten') fills.push(e) } catch {}
  }
}
function log(entry: Entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), live: LIVE, ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  appendFileSync(TRADES_FILE, line + '\n')
  const e = JSON.parse(line)
  if (e.event === 'cycle' || e.event === 'flatten') fills.push(e)
}

const status: Entry = {
  agent: { name: 'Kiyoshi', wallet: account.address, erc8004AgentId: AGENT_ID, attributionTag: ATTRIBUTION_TAG },
  live: LIVE, startedAt: new Date().toISOString(),
  config: { maxTradeUsd: MAX_TRADE_USD, minEdgeUsd: MIN_EDGE_USD, intervalSec: INTERVAL_MS / 1000 },
  lastScan: null, equity: null, baselineEquity: null, since: null, lastError: null,
}
function summary() {
  const cycles = fills.filter((f) => f.event === 'cycle' && typeof f.pnl === 'number')
  return {
    ...status,
    pnl: status.equity !== null ? status.equity - status.baselineEquity : null,
    realizedPnl: cycles.reduce((s, f) => s + f.pnl, 0),
    completedCycles: cycles.length,
    textileFills: fills.filter((f) => typeof f.textileUsd === 'number').length,
    textileVolumeUsd: fills.reduce((s, f) => s + (typeof f.textileUsd === 'number' ? f.textileUsd : 0), 0),
  }
}

// ---------- market helpers ----------
async function texPreview(sell: TokenKey, buy: TokenKey, amount: bigint): Promise<bigint | null> {
  try {
    const p = await preview({ sellToken: TOKENS[sell].address, buyToken: TOKENS[buy].address, sellAmount: amount.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}

async function bestExit(X: TokenKey, amount: bigint) {
  const [u, t] = await Promise.all([uniQuote(X, 'USDT', amount), texPreview(X, 'USDT', amount)])
  if (u && (!t || u.out >= t)) return { venue: 'uniswap' as const, out: u.out, fee: u.fee }
  if (t) return { venue: 'textile' as const, out: t }
  return null
}

// Read every balance at ONE block that already includes our latest tx, so equity is a consistent snapshot.
async function snapshotBlock() {
  for (let i = 0; i < 20; i++) {
    const b = await pub.getBlockNumber({ cacheTime: 0 })
    if (b >= lastTxBlock) return b
    await sleep(1000)
  }
  throw new Error('RPC is lagging behind our last transaction; skipping equity read')
}
async function readAt(token: `0x${string}`, block: bigint) {
  for (let i = 0; ; i++) {
    try { return await balanceOf(token, block) } catch (e) { if (i >= 5) throw e; await sleep(1000) }
  }
}
async function equity() {
  const block = await snapshotBlock()
  let total = usd(await readAt(TOKENS.USDT.address, block))
  for (const X of CORRIDORS) {
    const bal = await readAt(TOKENS[X].address, block)
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (exit) total += usd(exit.out)
  }
  return total
}

// Sell leftovers from a half-finished cycle. Returns true if it sold on Textile.
async function flatten() {
  let soldOnTextile = false
  for (const X of CORRIDORS) {
    const bal = await balanceOf(TOKENS[X].address)
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (!exit || usd(exit.out) < 1) continue // dust, or below Textile's $1 minimum
    console.log(`  flatten: ${amt(X, bal).toFixed(4)} ${X} -> ~${usd(exit.out).toFixed(4)} USDT via ${exit.venue}`)
    if (!LIVE) continue
    if (exit.venue === 'uniswap') {
      const { hash: tx, out } = await uniSwap(X, 'USDT', bal, exit.fee!, withSlippage(exit.out))
      log({ event: 'flatten', X, venue: 'uniswap', amountIn: bal, tx, usdtOut: usd(out) })
    } else {
      const r = await textileSwap(X, 'USDT', bal, withSlippage(exit.out))
      const filled = r.status === 'filled'
      log({ event: 'flatten', X, venue: 'textile', amountIn: bal, result: r, ...(filled ? { tx: r.txHash, usdtOut: usd(r.received), textileUsd: usd(r.received) } : {}) })
      if (filled) soldOnTextile = true
    }
  }
  return soldOnTextile
}

type Opp = { X: TokenKey; route: 'uni->textile' | 'textile->uni'; size: bigint; mid: bigint; out: bigint; uniFee: number; edge: number }

async function scan(size: bigint): Promise<Opp[]> {
  const opps: Opp[] = []
  for (const X of CORRIDORS) {
    const a1 = await uniQuote('USDT', X, size)
    const a2 = a1 ? await texPreview(X, 'USDT', a1.out) : null
    if (a1 && a2) opps.push({ X, route: 'uni->textile', size, mid: a1.out, out: a2, uniFee: a1.fee, edge: usd(a2) - usd(size) })

    const b1 = await texPreview('USDT', X, size)
    const b2 = b1 ? await uniQuote(X, 'USDT', b1) : null
    if (b1 && b2) opps.push({ X, route: 'textile->uni', size, mid: b1, out: b2.out, uniFee: b2.fee, edge: usd(b2.out) - usd(size) })
  }
  return opps.sort((a, b) => b.edge - a.edge)
}

async function execute(o: Opp): Promise<number | null> {
  const X = o.X
  if (o.route === 'uni->textile') {
    const { hash: tx1, out: got } = await uniSwap('USDT', X, o.size, o.uniFee, withSlippage(o.mid))
    // Sell on Textile only if the firm quote still breaks even; otherwise keep inventory for flatten().
    const r = await textileSwap(X, 'USDT', got, o.size)
    const filled = r.status === 'filled'
    const pnl = filled ? usd(r.received) - usd(o.size) : null
    log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1, leg2: r.status, ...(filled ? { tx2: r.txHash, textileUsd: usd(r.received) } : {}), pnl })
    return pnl
  }
  const r = await textileSwap('USDT', X, o.size, withSlippage(o.mid))
  if (r.status !== 'filled') { log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), leg1: r.status, pnl: null }); return null }
  const q = await uniQuote(X, 'USDT', r.received)
  if (!q) { log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, textileUsd: usd(o.size), leg2: 'no_uniswap_quote', pnl: null }); return null }
  const { hash: tx2, out } = await uniSwap(X, 'USDT', r.received, q.fee, withSlippage(q.out))
  const pnl = usd(out) - usd(o.size)
  log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, tx2, textileUsd: usd(o.size), pnl })
  return pnl
}

async function cycle() {
  if (await flatten()) {
    console.log('  sold leftovers on Textile; letting it settle before the next trade')
    return
  }
  const cash = await balanceOf(TOKENS.USDT.address)
  const cap = parseUnits(String(MAX_TRADE_USD), 6)
  const size = LIVE ? (cash * 90n / 100n < cap ? cash * 90n / 100n : cap) : cap
  if (size < parseUnits('2', 6)) {
    console.log(`  not enough USDT to trade (have ${usd(cash).toFixed(2)})`)
    return
  }

  const opps = await scan(size)
  for (const o of opps) console.log(`  ${o.X.padEnd(5)} ${o.route.padEnd(13)} $${usd(size).toFixed(2)} -> $${usd(o.out).toFixed(4)}  edge ${o.edge >= 0 ? '+' : ''}${o.edge.toFixed(4)}`)
  status.lastScan = { at: new Date().toISOString(), sizeUsd: usd(size), opps: opps.map((o) => ({ X: o.X, route: o.route, outUsd: usd(o.out), edge: o.edge })) }

  const best = opps[0]
  if (!best || best.edge < MIN_EDGE_USD) { console.log(`  no trade: best edge below $${MIN_EDGE_USD}`); return }
  console.log(`  >> ${LIVE ? 'TRADING' : 'would trade'}: ${best.X} ${best.route}, expected +$${best.edge.toFixed(4)}`)
  if (LIVE) {
    const pnl = await execute(best)
    console.log(`  result: ${pnl === null ? 'incomplete (leftover will be flattened)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDT'}`)
  }
}

// ---------- web endpoint ----------
if (PORT) {
  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body, null, 2)) }
    if (url.pathname === '/health') return res.end('ok')
    if (url.pathname === '/status') return json(summary())
    if (url.pathname === '/trades') {
      const n = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000)
      return json(fills.slice(-n).reverse())
    }
    res.statusCode = 404
    res.end('not found')
  }).listen(PORT, () => console.log(`Serving /health /status /trades on port ${PORT}`))
}

// ---------- baseline for P&L ----------
let state: { baselineEquity: number; since: string }
if (process.env.BASELINE_EQUITY) {
  state = { baselineEquity: Number(process.env.BASELINE_EQUITY), since: process.env.BASELINE_SINCE ?? new Date().toISOString() }
} else if (existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} else {
  state = { baselineEquity: await equity(), since: new Date().toISOString() }
  if (LIVE) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}
status.baselineEquity = state.baselineEquity
status.since = state.since

// ---------- main loop ----------
console.log(`Kiyoshi ${LIVE ? 'LIVE' : 'DRY RUN'} | wallet ${account.address} | max trade $${MAX_TRADE_USD} | min edge $${MIN_EDGE_USD} | every ${INTERVAL_MS / 1000}s`)
while (true) {
  console.log(`\n[${new Date().toISOString()}]`)
  try {
    await cycle()
    const eq = await equity()
    status.equity = eq
    status.lastError = null
    console.log(`  equity $${eq.toFixed(4)}  P&L since ${state.since.slice(0, 10)}: ${eq - state.baselineEquity >= 0 ? '+' : ''}${(eq - state.baselineEquity).toFixed(4)}`)
    log({ event: 'equity', equity: eq, pnl: eq - state.baselineEquity })
  } catch (e: any) {
    const msg = e.shortMessage ?? e.message
    console.error('  error:', msg)
    status.lastError = { at: new Date().toISOString(), message: msg }
    log({ event: 'error', message: msg })
  }
  if (ONCE && !PORT) break
  await sleep(INTERVAL_MS)
}
