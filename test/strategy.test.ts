import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits } from 'viem'
import { candidateSizes, edgeUsd, flattenFloor, parseLedger, pickBest, resolveBaseline, shouldHold, summarizeFills, tradeSize, withSlippage } from '../src/strategy.js'

const $ = (n: string) => parseUnits(n, 6)
const MIN = 60_000

test('slippage: 30 bps off a $1 quote', () => assert.equal(withSlippage($('1'), 30n), $('0.997')))
test('edge is out minus in, in dollars', () => assert.ok(Math.abs(edgeUsd($('20.05'), $('20')) - 0.05) < 1e-9))

test('flatten floor: 50 bps under cost', () => assert.equal(flattenFloor($('10'), 50n), $('9.95')))
test('flatten guard holds a losing exit while young', () => assert.equal(shouldHold($('9.90'), $('10'), 5 * MIN, 50n, 30 * MIN), true))
test('flatten guard sells a losing exit once max hold passes', () => assert.equal(shouldHold($('9.90'), $('10'), 31 * MIN, 50n, 30 * MIN), false))
test('flatten guard sells at or above the floor', () => {
  assert.equal(shouldHold($('9.95'), $('10'), 0, 50n, 30 * MIN), false)
  assert.equal(shouldHold($('10.10'), $('10'), 0, 50n, 30 * MIN), false)
})

test('live sizing: capped by MAX_TRADE', () => assert.deepEqual(tradeSize($('100'), $('20'), true), { size: $('20'), watchOnly: false }))
test('live sizing: 90% of cash when below the cap', () => assert.deepEqual(tradeSize($('10'), $('20'), true), { size: $('9'), watchOnly: false }))
test('live sizing: unfunded wallet scans at the cap in watch mode', () => assert.deepEqual(tradeSize($('1'), $('20'), true), { size: $('20'), watchOnly: true }))
test('dry run always scans at the cap', () => assert.deepEqual(tradeSize(0n, $('20'), false), { size: $('20'), watchOnly: false }))

test('candidate sizes: full, half, quarter', () => assert.deepEqual(candidateSizes($('20')), [$('20'), $('10'), $('5')]))
test('candidate sizes drop anything under the $2 minimum', () => {
  assert.deepEqual(candidateSizes($('6')), [$('6'), $('3')])
  assert.deepEqual(candidateSizes($('2')), [$('2')])
})

test('pickBest returns the largest edge', () => assert.equal(pickBest([{ edge: 0.02 }, { edge: 0.31 }, { edge: -1 }], 0.01)?.edge, 0.31))
test('pickBest returns null below the minimum edge', () => assert.equal(pickBest([{ edge: 0.005 }, { edge: -0.2 }], 0.01), null))
test('pickBest handles no opportunities', () => assert.equal(pickBest([], 0.01), null))

test('baseline follows net deposits, including negative after withdrawals', () => {
  assert.equal(resolveBaseline(250, 100), 250)
  assert.equal(resolveBaseline(-12.5, 100), -12.5)
  assert.equal(resolveBaseline(NaN, 100), 100)
})

test('ledger keeps only cycles and flattens, skips junk', () => {
  const text = [
    '{"event":"cycle","pnl":0.3}', '{"event":"scan"}', '{"event":"equity","equity":500}',
    'not json', '', '{"event":"flatten","usdtOut":9.9}',
  ].join('\n')
  assert.deepEqual(parseLedger(text).map((e) => e.event), ['cycle', 'flatten'])
})

test('summary: realized P&L counts completed cycles only, volume counts Textile fills', () => {
  const s = summarizeFills([
    { event: 'cycle', pnl: 0.5, textileUsd: 20 },
    { event: 'cycle', pnl: -0.1, textileUsd: 10 },
    { event: 'cycle', pnl: null },
    { event: 'flatten', textileUsd: 5 },
  ])
  assert.ok(Math.abs(s.realizedPnl - 0.4) < 1e-9)
  assert.equal(s.completedCycles, 2)
  assert.equal(s.textileFills, 3)
  assert.equal(s.textileVolumeUsd, 35)
})
