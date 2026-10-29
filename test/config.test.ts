import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAddress } from 'viem'
import { toDataSuffix } from '@celo/attribution-tags'
import { ATTRIBUTION_TAG, CHAIN_ID, CORRIDORS, TOKENS, TEXTILE_REACTOR, UNI } from '../src/config.js'

test('targets Celo mainnet', () => assert.equal(CHAIN_ID, 42220))
test('attribution tag has the Loops House format', () => assert.match(ATTRIBUTION_TAG, /^celo_[0-9a-f]{12}$/))
test('ERC-8021 data suffix encodes the tag', () => {
  const suffix = String(toDataSuffix(ATTRIBUTION_TAG)).toLowerCase()
  assert.ok(suffix.includes(Buffer.from(ATTRIBUTION_TAG).toString('hex')))
})
test('all contract and token addresses are valid', () => {
  for (const a of [TEXTILE_REACTOR, UNI.FACTORY, UNI.QUOTER, UNI.ROUTER]) assert.ok(isAddress(a, { strict: false }), a)
  for (const [k, t] of Object.entries(TOKENS)) {
    assert.ok(isAddress(t.address, { strict: false }), k)
    assert.ok([6, 18].includes(t.decimals), `${k} decimals`)
  }
})
test('token addresses are unique', () => {
  const addrs = Object.values(TOKENS).map(t => t.address.toLowerCase())
  assert.equal(new Set(addrs).size, addrs.length)
})
test('corridors are known tokens and never the base asset', () => {
  assert.ok(CORRIDORS.length > 0)
  for (const c of CORRIDORS) { assert.ok(c in TOKENS, c); assert.notEqual(c, 'USDT') }
})
