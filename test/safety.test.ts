import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

// The only files allowed to hold the key and send transactions (Celo and Base)
const SENDERS = ['wallet.ts', 'base/wallet.ts']
const src = (readdirSync('src', { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f: f.replace(/\\/g, '/'), s: readFileSync(`src/${f}`, 'utf8') }))

test('only the wallet modules can sign or send transactions', () => {
  for (const { f, s } of src) {
    if (SENDERS.includes(f)) continue
    assert.doesNotMatch(s, /createWalletClient\(|\.sendTransaction\(|\.writeContract\(|sendRawTransaction|privateKeyToAccount/, `${f} must send through a wallet module`)
  }
})
test('every wallet module tags transactions and validates the key', () => {
  for (const name of SENDERS) {
    const w = src.find((x) => x.f === name)?.s
    assert.ok(w, `${name} missing`)
    assert.match(w!, /concat\(\[tx\.data \?\? '0x', TAG_SUFFIX\]\)/, `${name} must tag every transaction`)
    assert.match(w!, /parsePrivateKey\(process\.env\.AGENT_PRIVATE_KEY\)/, `${name} must validate the key`)
  }
})
const STATE = ['.env', 'node_modules', 'trades.jsonl', 'state.json', 'flows.json', 'base-trades.jsonl', 'base-state.json']
test('secrets and runtime state are gitignored', () => {
  const gi = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim())
  for (const f of STATE) assert.ok(gi.some((l) => l === f || l === f + '/' || l === '/' + f), `${f} missing from .gitignore`)
})
test('no secret or state file is tracked by git', () => {
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n')
  for (const f of STATE.filter((f) => f !== 'node_modules')) assert.ok(!tracked.includes(f), `${f} is committed`)
})
