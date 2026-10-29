import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrivateKey } from '../src/keys.js'

const GOOD = '0x' + '1'.repeat(64)

test('accepts a 0x-prefixed 64-hex key', () => assert.equal(parsePrivateKey(GOOD), GOOD))
test('adds a missing 0x prefix', () => assert.equal(parsePrivateKey('1'.repeat(64)), GOOD))
test('trims spaces, newlines and quotes', () => assert.equal(parsePrivateKey(`  "${GOOD}"\n`), GOOD))
test('rejects missing or empty key', () => {
  assert.throws(() => parsePrivateKey(undefined), /not set/)
  assert.throws(() => parsePrivateKey('   '), /not set/)
})
test('rejects wrong length and non-hex', () => {
  assert.throws(() => parsePrivateKey('0x1234'), /malformed/)
  assert.throws(() => parsePrivateKey('0x' + 'g'.repeat(64)), /malformed/)
})
test('rejects zero key and keys outside the curve order', () => {
  assert.throws(() => parsePrivateKey('0x' + '0'.repeat(64)), /not a valid/)
  assert.throws(() => parsePrivateKey('0x' + 'f'.repeat(64)), /not a valid/)
})
test('never leaks the key in error messages', () => {
  const bad = '0x' + 'ab'.repeat(31) + 'a'
  try { parsePrivateKey(bad); assert.fail('should throw') } catch (e: any) { assert.ok(!e.message.includes(bad.slice(2, 20))) }
})
