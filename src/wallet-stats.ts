// Read-only: trading stats for any wallet running Kiyoshi's strategy.
// Usage: npx tsx src/wallet-stats.ts <address>
import { formatUnits, parseAbiItem, type Address, type Hex } from 'viem'
import { fromDataSuffix } from '@celo/attribution-tags'
import { pub } from './wallet.js'
import { ATTRIBUTION_TAG, TEXTILE_REACTOR, TOKENS, UNI, type TokenKey } from './config.js'

const who = (process.argv[2] ?? '').toLowerCase() as Address
if (!/^0x[0-9a-f]{40}$/.test(who)) { console.log('Usage: npx tsx src/wallet-stats.ts <address>'); process.exit(1) }
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const usd = (v: bigint) => Number(formatUnits(v, 6))
async function retry<T>(fn: () => Promise<T>): Promise<T> { for (let i = 0; ; i++) { try { return await fn() } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 1500)) } } }

// scan from Kiyoshi's registration (Oct 25), when the strategy first existed
const start = 81048354n, head = await retry(() => pub.getBlockNumber())
const keys = Object.keys(TOKENS) as TokenKey[]
const perTx = new Map<Hex, Partial<Record<TokenKey, bigint>>>()
for (const k of keys) for (const dir of ['from', 'to'] as const) {
  for (let a = start; a <= head; a += 2000n) {
    const b = a + 1999n > head ? head : a + 1999n
    const logs = await retry(() => pub.getLogs({ address: TOKENS[k].address, event: transfer, args: { [dir]: who } as any, fromBlock: a, toBlock: b }))
    for (const l of logs) { const d = perTx.get(l.transactionHash) ?? {}; d[k] = (d[k] ?? 0n) + (dir === 'to' ? 1n : -1n) * (l.args.value as bigint); perTx.set(l.transactionHash, d) }
  }
}

type Leg = { hash: Hex; block: bigint; venue: 'uniswap' | 'textile'; X: TokenKey; usdt: bigint; x: bigint; tagged: boolean }
const legs: Leg[] = []; let deposits = 0, withdrawals = 0, taggedTx = 0, sentTx = 0
for (const [hash, d] of perTx) {
  const tx = await retry(() => pub.getTransaction({ hash }))
  const stable = usd((d.USDT ?? 0n) + (d.USDC ?? 0n))
  if (tx.from.toLowerCase() !== who) { if (stable > 0) deposits += stable; continue }
  sentTx++
  const tag = fromDataSuffix(tx.input)
  const tagged = !!tag?.codes.includes(ATTRIBUTION_TAG); if (tagged) taggedTx++
  const to = tx.to?.toLowerCase()
  const venue = to === UNI.ROUTER.toLowerCase() ? 'uniswap' : to === TEXTILE_REACTOR.toLowerCase() ? 'textile' : null
  if (!venue) { if (stable < 0) withdrawals += -stable; continue }
  const X = keys.find((k) => k !== 'USDT' && (d[k] ?? 0n) !== 0n)
  if (X && d.USDT) legs.push({ hash, block: tx.blockNumber!, venue, X, usdt: d.USDT, x: d[X]!, tagged })
}
legs.sort((a, b) => (a.block < b.block ? -1 : 1))

// pair buys with sells on the other venue
const close = (a: bigint, b: bigint) => { const m = a > b ? a : b, diff = a > b ? a - b : b - a; return diff * 100n <= m }
const open: Leg[] = []; let trips = 0, wins = 0, pnl = 0, textileVol = 0, uniVol = 0
for (const l of legs) {
  if (l.venue === 'textile') textileVol += Math.abs(usd(l.usdt)); else uniVol += Math.abs(usd(l.usdt))
  if (l.usdt < 0n && l.x > 0n) { open.push(l); continue }
  const i = open.findIndex((o) => o.X === l.X && o.venue !== l.venue && close(o.x, -l.x))
  if (i < 0) continue
  const o = open.splice(i, 1)[0], p = usd(l.usdt) - usd(-o.usdt)
  trips++; pnl += p; if (p > 0) wins++
}
const first = legs[0] ? (await retry(() => pub.getBlock({ blockNumber: legs[0].block }))).timestamp : null

console.log(`\nWallet ${who}`)
console.log(`  first trade        ${first ? new Date(Number(first) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'none'}`)
console.log(`  round trips        ${trips} (${trips ? Math.round(wins / trips * 100) : 0}% profitable)`)
console.log(`  realized P&L       ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
console.log(`  Textile volume     $${textileVol.toFixed(2)}`)
console.log(`  Uniswap volume     $${uniVol.toFixed(2)}`)
console.log(`  total volume       $${(textileVol + uniVol).toFixed(2)}`)
console.log(`  deposits / withdrawals   $${deposits.toFixed(2)} / $${withdrawals.toFixed(2)}`)
console.log(`  txs sent           ${sentTx}, of which ${taggedTx} carry ${ATTRIBUTION_TAG}`)
