// Read-only: Textile FX vs Uniswap v3 gaps on Robinhood Chain (4663). Sends NO transactions.
import { createPublicClient, defineChain, formatUnits, http, parseAbi, parseUnits, type Address } from 'viem'

const rh = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } } })
const pub = createPublicClient({ chain: rh, transport: http() })
const QUOTER: Address = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'   // Uniswap v3 QuoterV2 on Robinhood Chain
const USDG = { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address, d: 6 }
const STOCKS: Record<string, Address> = {
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  SPY:  '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
  QQQ:  '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
}
const qAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])

async function uni(tin: Address, tout: Address, amt: bigint) {
  let best: bigint | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin, tokenOut: tout, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (best === null || result[0] > best) best = result[0]
    } catch {}
  }
  return best
}
async function tex(tin: Address, tout: Address, amt: bigint): Promise<bigint | string> {
  try {
    const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: 4663, sellToken: tin, buyToken: tout, sellAmount: amt.toString() }) })
    const j: any = await r.json()
    if (!r.ok) return 'no corridor'
    return j.data.status === 'preview' ? BigInt(j.data.buyAmount) : `no quote (${j.data.reason})`
  } catch { return 'error' }
}
const usd = (v: bigint) => Number(formatUnits(v, 6))
const bps = (out: bigint, size: number) => `${((usd(out) / size - 1) * 1e4).toFixed(1)} bps ($${(usd(out) - size).toFixed(3)})`

console.log(`Robinhood Chain block ${await pub.getBlockNumber()}  ·  ${new Date().toUTCString()}`)
for (const [sym, X] of Object.entries(STOCKS)) {
  console.log(`\n== ${sym} / USDG ==`)
  for (const size of [20, 100, 500]) {
    const amt = parseUnits(String(size), 6)
    const a1 = await uni(USDG.a, X, amt)                                    // buy on Uniswap
    const a2 = a1 !== null ? await tex(X, USDG.a, a1) : 'no pool'           // sell on Textile
    const b1 = await tex(USDG.a, X, amt)                                    // buy on Textile
    const b2 = typeof b1 === 'bigint' ? await uni(X, USDG.a, b1) : null     // sell on Uniswap
    const A = a1 === null ? 'no Uniswap pool' : typeof a2 === 'bigint' ? bps(a2, size) : `Textile ${a2}`
    const B = typeof b1 !== 'bigint' ? `Textile ${b1}` : b2 === null ? 'no Uniswap pool' : bps(b2, size)
    console.log(`  $${String(size).padStart(3)}  Uniswap->Textile: ${A.padEnd(30)} Textile->Uniswap: ${B}`)
  }
}
