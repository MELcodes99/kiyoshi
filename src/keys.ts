import type { Hex } from 'viem'

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// Validates the agent key read from env. Errors never include the key itself.
export function parsePrivateKey(raw: string | undefined, name = 'AGENT_PRIVATE_KEY'): Hex {
  if (raw === undefined || raw.trim() === '') throw new Error(`${name} is not set. Add it to .env (run: npm run new-wallet)`)
  let k = raw.trim().replace(/^['"]|['"]$/g, '')
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = '0x' + k
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    const len = k.startsWith('0x') ? k.length - 2 : k.length
    throw new Error(`${name} is malformed: expected 64 hex characters (0x prefix optional), got ${len}. Check for typos, spaces or a missing digit.`)
  }
  const n = BigInt(k)
  if (n === 0n || n >= SECP256K1_N) throw new Error(`${name} is not a valid secp256k1 private key`)
  return k as Hex
}
