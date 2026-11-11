// Allowances and Textile RFQ swaps on Base.
import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem'
import { account, balanceOf, pub, sendTx } from './wallet.js'
import { requestQuote, submitTx } from './textile.js'
import { BASE_TEXTILE_REACTOR, BASE_TOKENS, type BaseTokenKey } from './config.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function ensureAllowance(token: Address, spender: Address, required: bigint) {
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
  if (allowance >= required) return
  const approve = (amount: bigint) => sendTx({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })
  if (allowance > 0n) await approve(0n)
  await approve(maxUint256)
}

// Public RPCs can lag a block behind a fresh receipt, so wait for a balance to appear.
export async function waitForBalance(token: Address, need: bigint, label: string) {
  let bal = await balanceOf(token)
  for (let i = 0; bal < need && i < 15; i++) { await sleep(1000); bal = await balanceOf(token) }
  if (bal < need) throw new Error(`Not enough ${label}: have ${bal}, need ${need}`)
}

// One Textile RFQ swap. minReceived: refuse the firm quote (send nothing) if it pays less.
export async function textileSwap(sell: BaseTokenKey, buy: BaseTokenKey, sellAmount: bigint, minReceived?: bigint) {
  const sellToken = BASE_TOKENS[sell].address
  const buyToken = BASE_TOKENS[buy].address
  await waitForBalance(sellToken, sellAmount, sell)
  await ensureAllowance(sellToken, BASE_TEXTILE_REACTOR, sellAmount)

  let q: any
  for (let i = 0; ; i++) {
    try { q = await requestQuote({ sellToken, buyToken, sellAmount: sellAmount.toString() }); break } catch (e: any) {
      const msg = String(e.message)
      if (i < 3 && msg.includes('insufficient_funds')) {
        const m = msg.match(/"retryAfterMs":(\d+)/)
        const wait = m ? Math.min(Number(m[1]) + 2000, 120_000) : 3000
        console.log(`  Textile still sees those funds as reserved, waiting ${Math.round(wait / 1000)}s`)
        await sleep(wait)
        continue
      }
      throw e
    }
  }
  if (q.status === 'no_quote') return { status: 'no_quote' as const, reason: q.reason as string }

  const { rfqId, claimToken, quote, transactions } = q
  const reactor = String(quote.reactor).toLowerCase()
  if (reactor !== BASE_TEXTILE_REACTOR.toLowerCase() || String(transactions.swap.to).toLowerCase() !== reactor) {
    throw new Error(`Unexpected reactor ${quote.reactor}, refusing to trade`)
  }
  if (minReceived !== undefined && BigInt(quote.buyAmount) < minReceived) return { status: 'below_min' as const, rfqId, offered: BigInt(quote.buyAmount) }
  if (Date.now() >= Date.parse(quote.expiresAt) - 3_000) return { status: 'expired' as const, rfqId }

  const txHash = (await sendTx({ to: transactions.swap.to as Address, data: transactions.swap.data as Hex })).transactionHash
  await submitTx(rfqId, claimToken, txHash).catch(() => {})
  return { status: 'filled' as const, rfqId, txHash, paid: BigInt(quote.takerPays), received: BigInt(quote.buyAmount), fee: BigInt(quote.feeAmount) }
}
