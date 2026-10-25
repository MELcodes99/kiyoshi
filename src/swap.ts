import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem'
import { account, pub, sendTagged } from './wallet.js'
import { requestQuote, submitTx } from './textile.js'
import { TEXTILE_REACTOR, TOKENS, type TokenKey } from './config.js'

export async function balanceOf(token: Address) {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
}

async function ensureAllowance(token: Address, required: bigint) {
  const allowance = await pub.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, TEXTILE_REACTOR],
  })
  if (allowance >= required) return
  const approve = (amount: bigint) =>
    sendTagged({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEXTILE_REACTOR, amount] }) })
  if (allowance > 0n) await approve(0n) // USDT-style tokens refuse nonzero to nonzero
  await approve(maxUint256)
}

// One tagged RFQ swap on Textile. sellAmount is in atomic units.
export async function swap(sell: TokenKey, buy: TokenKey, sellAmount: bigint) {
  const sellToken = TOKENS[sell].address
  const buyToken = TOKENS[buy].address

  const bal = await balanceOf(sellToken)
  if (bal < sellAmount) throw new Error(`Not enough ${sell}: have ${bal}, need ${sellAmount}`)

  // Approve before quoting so the 60s quote window is not spent on approvals.
  await ensureAllowance(sellToken, sellAmount)

  const q = await requestQuote({ sellToken, buyToken, sellAmount: sellAmount.toString() })
  if (q.status === 'no_quote') return { status: 'no_quote' as const, reason: q.reason as string }

  const { rfqId, claimToken, quote, transactions } = q
  // Safety: only ever send to the reactor in Textile's published address book.
  const reactor = String(quote.reactor).toLowerCase()
  if (reactor !== TEXTILE_REACTOR.toLowerCase() || String(transactions.swap.to).toLowerCase() !== reactor) {
    throw new Error(`Unexpected reactor ${quote.reactor}, refusing to trade`)
  }
  if (Date.now() >= Date.parse(quote.expiresAt) - 3_000) return { status: 'expired' as const, rfqId }

  const txHash = await sendTagged({ to: transactions.swap.to as Address, data: transactions.swap.data as Hex })
  await submitTx(rfqId, claimToken, txHash).catch(() => {}) // courtesy call, fill is reconciled onchain anyway

  return {
    status: 'filled' as const,
    rfqId,
    txHash,
    paid: BigInt(quote.takerPays),
    received: BigInt(quote.buyAmount),
    fee: BigInt(quote.feeAmount),
  }
}
