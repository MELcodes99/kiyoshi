import { createPublicClient, createWalletClient, concat, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { toDataSuffix } from '@celo/attribution-tags'
import { ATTRIBUTION_TAG, RPC_URL } from './config.js'

const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined
if (!pk) throw new Error('Set AGENT_PRIVATE_KEY in .env (run: npm run new-wallet)')

export const account = privateKeyToAccount(pk)
export const pub = createPublicClient({ chain: celo, transport: http(RPC_URL) })
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC_URL) })

export const TAG_SUFFIX = toDataSuffix(ATTRIBUTION_TAG) as Hex

// The ONLY way the agent sends transactions, so nothing ever goes out untagged.
export async function sendTagged(tx: { to: Address; data?: Hex; value?: bigint }): Promise<Hex> {
  const data = concat([tx.data ?? '0x', TAG_SUFFIX])
  const hash = await wallet.sendTransaction({ to: tx.to, data, value: tx.value ?? 0n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
  return hash
}
