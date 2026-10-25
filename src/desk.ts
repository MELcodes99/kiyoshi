// The trading loop. Dry run by default; set LIVE=1 to trade real money.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { formatUnits, parseUnits } from 'viem'
import { CORRIDORS, TOKENS, type TokenKey } from './config.js'
import { balanceOf, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuote, uniSwap } from './uniswap.js'

const LIVE = process.env.LIVE === '1'
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? '20')
const MIN_EDGE_USD = Number(process.env.MIN_EDGE_USD ?? '0.01')
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '60') * 1000
const SLIPPAGE_BPS = 30n // 0.3%
const ONCE = process.env.ONCE === '1'

const usd = (v: bigint) => Number(formatUnits(v, 6))
const amt = (k: TokenKey, v: bigint) => Number(formatUnits(v, TOKENS[k].decimals))
const withSlippage = (v: bigint) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), live: LIVE, ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  appendFileSync('trades.jsonl', line + '\n')
}

async function texPreview(sell: TokenKey, buy: TokenKey, amount: bigint): Promise<bigint | null> {
  try {
    const p = await preview({ sellToken: TOKENS[sell].address, buyToken: TOKENS[buy].address, sellAmount: amount.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}

// Best price to turn `amount` of X into USDT right now, and where.
async function bestExit(X: TokenKey, amount: bigint) {
  const [u, t] = await Promise.all([uniQuote(X, 'USDT', amount), texPreview(X, 'USDT', amount)])
  if (u && (!t || u.out >= t)) return { venue: 'uniswap' as const, out: u.out, fee: u.fee }
  if (t) return { venue: 'textile' as const, out: t }
  return null
}

// Total equity in USDT: cash plus inventory marked at its best exit.
async function equity() {
  let total = usd(await balanceOf(TOKENS.USDT.address))
  for (const X of CORRIDORS) {
    const bal = await balanceOf(TOKENS[X].address)
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (exit) total += usd(exit.out)
  }
  return total
}

// Sell leftover inventory from a half-finished cycle.
async function flatten() {
  for (const X of CORRIDORS) {
    const bal = await balanceOf(TOKENS[X].address)
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (!exit || usd(exit.out) < 1) continue // dust, or below Textile's $1 minimum
    console.log(`  flatten: ${amt(X, bal).toFixed(4)} ${X} -> ~${usd(exit.out).toFixed(4)} USDT via ${exit.venue}`)
    if (!LIVE) continue
    if (exit.venue === 'uniswap') {
      const tx = await uniSwap(X, 'USDT', bal, exit.fee!, withSlippage(exit.out))
      log({ event: 'flatten', X, venue: 'uniswap', amountIn: bal, tx })
    } else {
      const r = await textileSwap(X, 'USDT', bal, withSlippage(exit.out))
      log({ event: 'flatten', X, venue: 'textile', amountIn: bal, result: r })
    }
  }
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

async function execute(o: Opp) {
  const X = o.X
  if (o.route === 'uni->textile') {
    const before = await balanceOf(TOKENS[X].address)
    const tx1 = await uniSwap('USDT', X, o.size, o.uniFee, withSlippage(o.mid))
    const got = (await balanceOf(TOKENS[X].address)) - before
    // Sell on Textile only if the firm quote still breaks even; otherwise keep inventory for flatten().
    const r = await textileSwap(X, 'USDT', got, o.size)
    log({ event: 'cycle', X, route: o.route, size: o.size, tx1, leg2: r, pnl: r.status === 'filled' ? usd(r.received) - usd(o.size) : null })
    return r.status === 'filled' ? usd(r.received) - usd(o.size) : null
  } else {
    const r = await textileSwap('USDT', X, o.size, withSlippage(o.mid))
    if (r.status !== 'filled') { log({ event: 'cycle', X, route: o.route, size: o.size, leg1: r }); return null }
    const q = await uniQuote(X, 'USDT', r.received)
    if (!q) { log({ event: 'cycle', X, route: o.route, leg1: r, leg2: 'no_uniswap_quote' }); return null }
    const before = await balanceOf(TOKENS.USDT.address)
    const tx2 = await uniSwap(X, 'USDT', r.received, q.fee, withSlippage(q.out))
    const out = (await balanceOf(TOKENS.USDT.address)) - before
    log({ event: 'cycle', X, route: o.route, size: o.size, tx1: r.txHash, tx2, pnl: usd(out) - usd(o.size) })
    return usd(out) - usd(o.size)
  }
}

async function cycle() {
  await flatten()
  const cash = await balanceOf(TOKENS.USDT.address)
  const cap = parseUnits(String(MAX_TRADE_USD), 6)
  const size = LIVE ? (cash * 90n / 100n < cap ? cash * 90n / 100n : cap) : cap
  if (size < parseUnits('2', 6)) {
    console.log(`  not enough USDT to trade (have ${usd(cash).toFixed(2)})`)
    return
  }

  const opps = await scan(size)
  for (const o of opps) console.log(`  ${o.X.padEnd(5)} ${o.route.padEnd(13)} $${usd(size).toFixed(2)} -> $${usd(o.out).toFixed(4)}  edge ${o.edge >= 0 ? '+' : ''}${o.edge.toFixed(4)}`)
  log({ event: 'scan', size, opps: opps.map((o) => ({ X: o.X, route: o.route, edge: o.edge })) })

  const best = opps[0]
  if (!best || best.edge < MIN_EDGE_USD) { console.log(`  no trade: best edge below $${MIN_EDGE_USD}`); return }
  console.log(`  >> ${LIVE ? 'TRADING' : 'would trade'}: ${best.X} ${best.route}, expected +$${best.edge.toFixed(4)}`)
  if (LIVE) {
    const pnl = await execute(best)
    console.log(`  result: ${pnl === null ? 'incomplete (leftover will be flattened)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDT'}`)
  }
}

// Baseline equity for running P&L
const STATE = 'state.json'
const startEquity = await equity()
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { baselineEquity: startEquity, since: new Date().toISOString() }
if (!existsSync(STATE) && LIVE) writeFileSync(STATE, JSON.stringify(state, null, 2))

console.log(`Naira Desk ${LIVE ? 'LIVE' : 'DRY RUN'} | max trade $${MAX_TRADE_USD} | min edge $${MIN_EDGE_USD} | every ${INTERVAL_MS / 1000}s`)
while (true) {
  console.log(`\n[${new Date().toLocaleTimeString()}]`)
  try {
    await cycle()
    const eq = await equity()
    console.log(`  equity $${eq.toFixed(4)}  P&L since ${state.since.slice(0, 10)}: ${eq - state.baselineEquity >= 0 ? '+' : ''}${(eq - state.baselineEquity).toFixed(4)}`)
    log({ event: 'equity', equity: eq, pnl: eq - state.baselineEquity })
  } catch (e: any) {
    console.error('  error:', e.shortMessage ?? e.message)
    log({ event: 'error', message: e.shortMessage ?? e.message })
  }
  if (ONCE) break
  await sleep(INTERVAL_MS)
}
