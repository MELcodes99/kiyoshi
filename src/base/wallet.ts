// The ONLY way Kiyoshi Base sends transactions, so nothing goes out untagged or with a bad key.
import { createPublicClient, createWalletClient, concat, erc20Abi, http, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { toDataSuffix } from '@celo/attribution-tags'
import { ATTRIBUTION_TAG } from '../config.js'
import { parsePrivateKey } from '../keys.js'
import { BASE_RPC } from './config.js'

export const account = privateKeyToAccount(parsePrivateKey(process.env.AGENT_PRIVATE_KEY))
export const pub = createPublicClient({ chain: base, transport: http(BASE_RPC) })
const wallet = createWalletClient({ account, chain: base, transport: http(BASE_RPC) })
const TAG_SUFFIX = toDataSuffix(ATTRIBUTION_TAG) as Hex

export async function sendTx(tx: { to: Address; data?: Hex; value?: bigint }): Promise<TransactionReceipt> {
  const data = concat([tx.data ?? '0x', TAG_SUFFIX])
  const hash = await wallet.sendTransaction({ to: tx.to, data, value: tx.value ?? 0n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Base transaction reverted: ${hash}`)
  return receipt
}

export const balanceOf = (token: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
export const ethBalance = () => pub.getBalance({ address: account.address })
