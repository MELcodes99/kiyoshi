// Pure decision logic for Kiyoshi. No network, no wallet: everything here is unit tested.
import { formatUnits, parseUnits } from 'viem'

export const BPS = 10_000n
export const MIN_TRADE = parseUnits('2', 6) // Textile minimum plus a margin, in USDT units

export const usd = (v: bigint) => Number(formatUnits(v, 6))

/** Minimum acceptable output after allowing `bps` of slippage. */
export const withSlippage = (v: bigint, bps: bigint) => (v * (BPS - bps)) / BPS

/** Dollar edge of a round trip: what comes back minus what went in (both USDT units). */
export const edgeUsd = (out: bigint, size: bigint) => usd(out) - usd(size)

/** Lowest exit price flatten() accepts for leftover inventory bought at `costUsdt`. */
export const flattenFloor = (costUsdt: bigint, maxLossBps: bigint) => (costUsdt * (BPS - maxLossBps)) / BPS

/** Hold leftovers while the best exit loses more than the guard allows, but never longer than maxHoldMs. */
export function shouldHold(exitOut: bigint, costUsdt: bigint, ageMs: number, maxLossBps: bigint, maxHoldMs: number) {
  return exitOut < flattenFloor(costUsdt, maxLossBps) && ageMs < maxHoldMs
}

/** Trade size: live uses 90% of cash up to the cap; below the minimum it scans at the cap in watch mode. */
export function tradeSize(cash: bigint, cap: bigint, live: boolean) {
  let size = live ? (cash * 90n / 100n < cap ? cash * 90n / 100n : cap) : cap
  const watchOnly = size < MIN_TRADE
  if (watchOnly) size = cap
  return { size, watchOnly }
}

/** Sizes to try: big trades move Uniswap's price, so the best dollar profit is not always at max size. */
export const candidateSizes = (size: bigint) => [...new Set([size, size / 2n, size / 4n])].filter((s) => s >= MIN_TRADE)

export const byEdge = (a: { edge: number }, b: { edge: number }) => b.edge - a.edge

/** Best opportunity if it clears the minimum edge, else null. */
export function pickBest<T extends { edge: number }>(opps: T[], minEdgeUsd: number): T | null {
  const best = [...opps].sort(byEdge)[0]
  return best && best.edge >= minEdgeUsd ? best : null
}

/** P&L baseline follows net deposits (may be negative after withdrawals); keep the old one if unknown. */
export const resolveBaseline = (netDeposits: number, current: number) => (Number.isFinite(netDeposits) ? netDeposits : current)

type Fill = Record<string, any>

/** Load completed cycles and flattens from the JSONL ledger, skipping scans, equity rows and bad lines. */
export function parseLedger(text: string): Fill[] {
  const out: Fill[] = []
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e.event === 'cycle' || e.event === 'flatten') out.push(e) } catch {}
  }
  return out
}

/** Headline numbers for /status. */
export function summarizeFills(fills: Fill[]) {
  const cycles = fills.filter((f) => f.event === 'cycle' && typeof f.pnl === 'number')
  return {
    realizedPnl: cycles.reduce((s, f) => s + f.pnl, 0),
    completedCycles: cycles.length,
    textileFills: fills.filter((f) => typeof f.textileUsd === 'number').length,
    textileVolumeUsd: fills.reduce((s, f) => s + (typeof f.textileUsd === 'number' ? f.textileUsd : 0), 0),
  }
}
