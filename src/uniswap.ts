import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { account, pub, sendTagged } from './wallet.js'
import { ensureAllowance } from './swap.js'
import { TOKENS, UNI, type TokenKey } from './config.js'

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
])

let routerVerified = false
async function verifyRouter() {
  if (routerVerified) return
  const f = await pub.readContract({ address: UNI.ROUTER, abi: routerAbi, functionName: 'factory' })
  if (f.toLowerCase() !== UNI.FACTORY.toLowerCase()) throw new Error(`Router factory mismatch (${f}), refusing to trade`)
  routerVerified = true
}

// Best quote across v3 fee tiers. Read-only.
export async function uniQuote(tin: TokenKey, tout: TokenKey, amountIn: bigint) {
  let best: { out: bigint; fee: number } | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({
        address: UNI.QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
      if (!best || result[0] > best.out) best = { out: result[0], fee }
    } catch {}
  }
  return best
}

// Tagged swap through SwapRouter02. Reverts onchain if output < minOut.
export async function uniSwap(tin: TokenKey, tout: TokenKey, amountIn: bigint, fee: number, minOut: bigint): Promise<Hex> {
  await verifyRouter()
  await ensureAllowance(TOKENS[tin].address, UNI.ROUTER, amountIn)
  return sendTagged({
    to: UNI.ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, fee,
        recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }],
    }),
  })
}
