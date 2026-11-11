// Uniswap v4 quotes and swaps for the cNGN/USDC pool on Base (Universal Router + Permit2).
import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { account, pub, sendTx } from './wallet.js'
import { ensureAllowance, waitForBalance } from './swap.js'
import { CNGN_POOL, V4 } from './config.js'
import { encodeExactInSingle } from './v4.js'

const KEY = CNGN_POOL.key
const MAX_UINT160 = (1n << 160n) - 1n
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export async function v4Quote(tokenIn: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await pub.simulateContract({
      address: V4.QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: KEY, zeroForOne: tokenIn.toLowerCase() === KEY.currency0.toLowerCase(), exactAmount: amountIn, hookData: '0x' }],
    })
    return result[0]
  } catch { return null }
}

async function ensurePermit2(token: Address, amount: bigint) {
  await ensureAllowance(token, V4.PERMIT2, amount)
  const [allowed, expiration] = await pub.readContract({ address: V4.PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [account.address, token, V4.ROUTER] })
  const now = Math.floor(Date.now() / 1000)
  if (allowed >= amount && expiration > now + 3600) return
  await sendTx({ to: V4.PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, V4.ROUTER, MAX_UINT160, now + 30 * 86400] }) })
}

/** Swap exact amountIn through the pool; the router reverts if output < minOut. Returns the amount received. */
export async function v4Swap(tokenIn: Address, amountIn: bigint, minOut: bigint): Promise<{ hash: Hex; out: bigint }> {
  const tokenOut = tokenIn.toLowerCase() === KEY.currency0.toLowerCase() ? KEY.currency1 : KEY.currency0
  await waitForBalance(tokenIn, amountIn, 'input token')
  await ensurePermit2(tokenIn, amountIn)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
  const receipt = await sendTx({ to: V4.ROUTER, data: encodeExactInSingle(KEY, tokenIn, amountIn, minOut, deadline) })
  let out = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenOut.toLowerCase()) continue
    try {
      const ev: any = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics })
      if (String(ev.args.to).toLowerCase() === account.address.toLowerCase()) out += ev.args.value
    } catch {}
  }
  if (out === 0n) { console.warn('  could not read swap output from logs; using the guaranteed minimum'); out = minOut }
  return { hash: receipt.transactionHash, out }
}
