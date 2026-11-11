// Kiyoshi Base: trades cNGN/USDC between Textile (RFQ) and Uniswap v4 on Base.
// Dry run by default; LIVE=1 trades real money. Same guard rails as Kiyoshi on Celo, all set by env.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { formatUnits, parseEther, parseUnits } from 'viem'
import { ATTRIBUTION_TAG } from '../config.js'
import { account, balanceOf, ethBalance } from './wallet.js'
import { BASE_TOKENS } from './config.js'
import { preview } from './textile.js'
import { textileSwap } from './swap.js'
import { v4Quote, v4Swap } from './uniswap.js'
import { byEdge, candidateSizes, edgeUsd, parseLedger, pickBest, shouldHold, pnlSeries, summarizeFills, tradeSize, usd, withSlippage as slip } from '../strategy.js'
import { textileStats } from '../textileLimit.js'

const LIVE = process.env.LIVE === '1'
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? '100')
const MIN_EDGE_USD = Number(process.env.MIN_EDGE_USD ?? '0.01')
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '60') * 1000
const CHASE_MS = Number(process.env.CHASE_SEC ?? '10') * 1000
const MAX_FLATTEN_LOSS_BPS = BigInt(process.env.MAX_FLATTEN_LOSS_BPS ?? '50')
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MIN ?? '30') * 60_000
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? '30')
const MIN_GAS_WEI = parseEther(process.env.MIN_GAS_ETH ?? '0.0002')
const PORT = Number(process.env.PORT ?? 0)
const ONCE = process.env.ONCE === '1'
const DATA_DIR = process.env.DATA_DIR ?? '.'
const TRADES_FILE = DATA_DIR + '/base-trades.jsonl'
const STATE_FILE = DATA_DIR + '/base-state.json'

const USDC = BASE_TOKENS.USDC.address
const CNGN = BASE_TOKENS.cNGN.address
const MIN_EDGE_UNITS = parseUnits(String(MIN_EDGE_USD), 6)
const withSlippage = (v: bigint) => slip(v, SLIPPAGE_BPS)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Route = 'textile->uni' | 'uni->textile'
type Opp = { route: Route; size: bigint; mid: bigint; out: bigint; edge: number }
let chase: Route | null = null
let pending: { costUsdc: bigint; since: number } | null = null

// ---------- ledger ----------
type Entry = Record<string, any>
const fills: Entry[] = existsSync(TRADES_FILE) ? parseLedger(readFileSync(TRADES_FILE, 'utf8')) : []
function log(entry: Entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), live: LIVE, ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  appendFileSync(TRADES_FILE, line + '\n')
  const e = JSON.parse(line)
  if (e.event === 'cycle' || e.event === 'flatten') fills.push(e)
}

const status: Entry = {
  agent: { name: 'Kiyoshi Base', chain: 'base', wallet: account.address, pair: 'cNGN/USDC', venues: ['Textile RFQ', 'Uniswap v4'], attributionTag: ATTRIBUTION_TAG },
  live: LIVE, startedAt: new Date().toISOString(),
  config: { maxTradeUsd: MAX_TRADE_USD, minEdgeUsd: MIN_EDGE_USD, intervalSec: INTERVAL_MS / 1000, chaseSec: CHASE_MS / 1000, maxFlattenLossBps: Number(MAX_FLATTEN_LOSS_BPS), maxHoldMin: MAX_HOLD_MS / 60_000, slippageBps: Number(SLIPPAGE_BPS), minGasEth: Number(formatUnits(MIN_GAS_WEI, 18)) },
  lastScan: null, equity: null, baselineEquity: null, since: null, holding: false, watchOnly: false, gasEth: null, lastError: null,
}
const summary = () => ({ ...status, pnl: status.equity !== null ? status.equity - status.baselineEquity : null, ...summarizeFills(fills), textile: textileStats })

// ---------- market ----------
async function texPreview(sell: `0x${string}`, buy: `0x${string}`, amount: bigint): Promise<bigint | null> {
  try { const p: any = await preview({ sellToken: sell, buyToken: buy, sellAmount: amount.toString() }); return p.status === 'preview' ? BigInt(p.buyAmount) : null } catch { return null }
}
async function bestExit(amount: bigint) {
  const [u, t] = await Promise.all([v4Quote(CNGN, amount), texPreview(CNGN, USDC, amount)])
  if (u !== null && (t === null || u >= t)) return { venue: 'uniswap' as const, out: u }
  if (t !== null) return { venue: 'textile' as const, out: t }
  return null
}
async function scan(size: bigint): Promise<Opp[]> {
  const opps: Opp[] = []
  if (!chase || chase === 'textile->uni') {
    const a1 = await texPreview(USDC, CNGN, size)
    const a2 = a1 !== null ? await v4Quote(CNGN, a1) : null
    if (a1 !== null && a2 !== null) opps.push({ route: 'textile->uni', size, mid: a1, out: a2, edge: edgeUsd(a2, size) })
  }
  if (!chase || chase === 'uni->textile') {
    const b1 = await v4Quote(USDC, size)
    const b2 = b1 !== null ? await texPreview(CNGN, USDC, b1) : null
    if (b1 !== null && b2 !== null) opps.push({ route: 'uni->textile', size, mid: b1, out: b2, edge: edgeUsd(b2, size) })
  }
  return opps
}
// Least cNGN the first leg must deliver so the round trip still clears the minimum edge.
const firstLegMin = (o: Opp) => (o.mid * (o.size + MIN_EDGE_UNITS)) / o.out

async function execute(o: Opp): Promise<number | null> {
  if (o.route === 'textile->uni') {
    const r = await textileSwap('USDC', 'cNGN', o.size, firstLegMin(o))
    if (r.status !== 'filled') { log({ event: 'cycle', route: o.route, sizeUsd: usd(o.size), leg1: r.status, pnl: null }); return null }
    const q = await v4Quote(CNGN, r.received)
    if (q === null || shouldHold(q, o.size, 0, MAX_FLATTEN_LOSS_BPS, MAX_HOLD_MS)) {
      pending = { costUsdc: o.size, since: Date.now() }
      log({ event: 'cycle', route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, textileUsd: usd(o.size), leg2: q === null ? 'no_uniswap_quote' : 'uniswap_price_collapsed', pnl: null })
      return null
    }
    const { hash: tx2, out } = await v4Swap(CNGN, r.received, withSlippage(q))
    const pnl = usd(out) - usd(o.size)
    log({ event: 'cycle', route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, tx2, textileUsd: usd(o.size), pnl })
    return pnl
  }
  const { hash: tx1, out: got } = await v4Swap(USDC, o.size, firstLegMin(o))
  const r = await textileSwap('cNGN', 'USDC', got, o.size) // sell only if it at least breaks even
  const filled = r.status === 'filled'
  const pnl = filled ? usd(r.received) - usd(o.size) : null
  if (!filled) pending = { costUsdc: o.size, since: Date.now() }
  log({ event: 'cycle', route: o.route, sizeUsd: usd(o.size), tx1, leg2: r.status, ...(filled ? { tx2: r.txHash, textileUsd: usd(r.received) } : {}), pnl })
  return pnl
}

// Sell leftover cNGN from a half-finished cycle, unless that loses more than the guard allows.
// Returns true when the cycle should not open a new trade.
async function flatten(): Promise<boolean> {
  status.holding = false
  const bal = await balanceOf(CNGN)
  if (bal === 0n) { pending = null; return false }
  const exit = await bestExit(bal)
  if (!exit || usd(exit.out) < 1) return false // dust or below Textile's $1 minimum
  if (pending) {
    const age = Date.now() - pending.since
    if (shouldHold(exit.out, pending.costUsdc, age, MAX_FLATTEN_LOSS_BPS, MAX_HOLD_MS)) {
      console.log(`  holding cNGN: best exit $${usd(exit.out).toFixed(4)} vs cost $${usd(pending.costUsdc).toFixed(4)} (${Math.round(age / 60_000)}/${MAX_HOLD_MS / 60_000} min)`)
      status.holding = true
      return true
    }
  }
  console.log(`  flatten: ${formatUnits(bal, 6)} cNGN -> ~$${usd(exit.out).toFixed(4)} via ${exit.venue}`)
  if (!LIVE) return false
  if (exit.venue === 'uniswap') {
    const { hash, out } = await v4Swap(CNGN, bal, withSlippage(exit.out))
    log({ event: 'flatten', venue: 'uniswap', tx: hash, usdcOut: usd(out), costUsdc: pending ? usd(pending.costUsdc) : null })
    pending = null
  } else {
    const r = await textileSwap('cNGN', 'USDC', bal, withSlippage(exit.out))
    const filled = r.status === 'filled'
    log({ event: 'flatten', venue: 'textile', result: r, costUsdc: pending ? usd(pending.costUsdc) : null, ...(filled ? { tx: r.txHash, usdcOut: usd(r.received), textileUsd: usd(r.received) } : {}) })
    if (filled) pending = null; else status.holding = true
  }
  return true
}

async function equity() {
  let total = usd(await balanceOf(USDC))
  const bal = await balanceOf(CNGN)
  if (bal > 0n) { const e = await bestExit(bal); if (e) total += usd(e.out) }
  return total
}

async function cycle() {
  if (await flatten()) return
  const [cash, eth] = await Promise.all([balanceOf(USDC), ethBalance()])
  status.gasEth = Number(formatUnits(eth, 18))
  const lowGas = eth < MIN_GAS_WEI
  const { size, watchOnly } = tradeSize(cash, parseUnits(String(MAX_TRADE_USD), 6), LIVE)
  status.watchOnly = watchOnly || (LIVE && lowGas)
  if (watchOnly) console.log(`  not enough USDC to trade (have ${usd(cash).toFixed(2)}); scanning in watch mode`)

  const [first, ...rest] = candidateSizes(size)
  const opps: Opp[] = first !== undefined ? await scan(first) : []
  if (opps.some((o) => o.edge > -usd(o.size) * 0.002)) for (const s of rest) opps.push(...(await scan(s)))
  opps.sort(byEdge)
  for (const o of opps.filter((o) => o.size === size)) console.log(`  cNGN ${o.route.padEnd(13)} $${usd(o.size).toFixed(2)} -> $${usd(o.out).toFixed(4)}  edge ${o.edge >= 0 ? '+' : ''}${o.edge.toFixed(4)}`)
  status.lastScan = { at: new Date().toISOString(), maxSizeUsd: usd(size), opps: opps.map((o) => ({ route: o.route, sizeUsd: usd(o.size), outUsd: usd(o.out), edge: o.edge })) }

  const best = pickBest(opps, MIN_EDGE_USD)
  if (!best) { if (chase) console.log('  gap closed, back to full scans'); chase = null; console.log(`  no trade: best edge below $${MIN_EDGE_USD}`); return }
  if (watchOnly) { console.log(`  watch mode: edge of $${best.edge.toFixed(4)} available, fund the wallet with USDC to trade it`); return }
  if (LIVE && lowGas) { console.log(`  ETH for gas below ${formatUnits(MIN_GAS_WEI, 18)}; top up ETH on Base to trade`); status.lastError = { at: new Date().toISOString(), message: 'low ETH for gas' }; return }
  console.log(`  >> ${LIVE ? 'TRADING' : 'would trade'}: cNGN ${best.route} at $${usd(best.size).toFixed(2)}, expected +$${best.edge.toFixed(4)}`)
  if (LIVE) {
    const pnl = await execute(best)
    chase = pnl !== null && pnl > 0 ? best.route : null
    console.log(`  result: ${pnl === null ? 'incomplete (leftover held and managed by flatten)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDC'}`)
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
    if (url.pathname === '/pnl') return json(pnlSeries(fills))
    if (url.pathname === '/pnl-raw') return json(fills.filter((f) => f.event === 'cycle' && typeof f.pnl === 'number').map((f) => ({ ts: f.ts, pnl: f.pnl })))
    if (url.pathname === '/trades') return json(fills.slice(-Math.min(Number(url.searchParams.get('limit') ?? 100), 1000)).reverse())
    res.statusCode = 404
    res.end('not found')
  }).listen(PORT, () => console.log(`Serving /health /status /trades on port ${PORT}`))
}

// ---------- P&L baseline ----------
let state: { baselineEquity: number; since: string }
if (process.env.BASELINE_EQUITY) state = { baselineEquity: Number(process.env.BASELINE_EQUITY), since: process.env.BASELINE_SINCE ?? new Date().toISOString() }
else if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
else { state = { baselineEquity: await equity(), since: new Date().toISOString() }; if (LIVE) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) }
if (!Number.isFinite(state.baselineEquity)) throw new Error('BASELINE_EQUITY is not a plain number')
status.baselineEquity = state.baselineEquity
status.since = state.since

// ---------- safe shutdown ----------
let stopping = false
let inCycle = false
process.on('SIGTERM', () => { stopping = true; console.log('  SIGTERM received' + (inCycle ? '; finishing the current cycle first' : '')); if (!inCycle) process.exit(0) })
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_SEC ?? (LIVE ? '60' : '0')) * 1000
if (STARTUP_DELAY_MS > 0) { console.log(`Waiting ${STARTUP_DELAY_MS / 1000}s before trading so any previous copy can shut down`); await sleep(STARTUP_DELAY_MS) }

// ---------- main loop ----------
console.log(`Kiyoshi Base ${LIVE ? 'LIVE' : 'DRY RUN'} | cNGN/USDC | wallet ${account.address} | max trade $${MAX_TRADE_USD} | min edge $${MIN_EDGE_USD} | every ${INTERVAL_MS / 1000}s`)
while (true) {
  console.log(`\n[${new Date().toISOString()}]`)
  if (stopping) break
  inCycle = true
  try {
    await cycle()
    const eq = await equity()
    status.equity = eq
    status.lastError = status.lastError?.message === 'low ETH for gas' ? status.lastError : null
    console.log(`  equity $${eq.toFixed(4)}  P&L since ${state.since.slice(0, 10)}: ${eq - state.baselineEquity >= 0 ? '+' : ''}${(eq - state.baselineEquity).toFixed(4)}  | gas ${status.gasEth?.toFixed(5)} ETH`)
    log({ event: 'equity', equity: eq, pnl: eq - state.baselineEquity })
  } catch (e: any) {
    const msg = e.shortMessage ?? e.message
    console.error('  error:', msg)
    status.lastError = { at: new Date().toISOString(), message: msg }
    log({ event: 'error', message: msg })
  }
  inCycle = false
  if (stopping) { console.log('  shutdown requested; exiting cleanly between cycles'); process.exit(0) }
  if (ONCE && !PORT) break
  await sleep(chase ? CHASE_MS : INTERVAL_MS)
}
