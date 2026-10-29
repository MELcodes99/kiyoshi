import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const src = readdirSync('src').filter(f => f.endsWith('.ts')).map(f => ({ f, s: readFileSync(`src/${f}`, 'utf8') }))

test('only wallet.ts can sign or send transactions', () => {
  for (const { f, s } of src) {
    if (f === 'wallet.ts') continue
    assert.doesNotMatch(s, /createWalletClient\(|\.sendTransaction\(|\.writeContract\(|sendRawTransaction|privateKeyToAccount/, `${f} must send through sendTagged`)
  }
})
test('every transaction carries the attribution suffix', () => {
  const w = src.find(x => x.f === 'wallet.ts')!.s
  assert.match(w, /concat\(\[tx\.data \?\? '0x', TAG_SUFFIX\]\)/)
  assert.match(w, /parsePrivateKey\(process\.env\.AGENT_PRIVATE_KEY\)/)
})
test('secrets and runtime state are gitignored', () => {
  const gi = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map(l => l.trim())
  for (const f of ['.env', 'node_modules', 'trades.jsonl', 'state.json', 'flows.json']) assert.ok(gi.some(l => l === f || l === f + '/' || l === '/' + f), `${f} missing from .gitignore`)
})
test('no secret or state file is tracked by git', () => {
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n')
  for (const f of ['.env', 'trades.jsonl', 'state.json', 'flows.json']) assert.ok(!tracked.includes(f), `${f} is committed`)
})
