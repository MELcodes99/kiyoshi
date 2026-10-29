// Read-only: Textile vs AMM gaps on BNB Chain and Polygon. Sends NO transactions.
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address } from 'viem'
import { bsc, polygon } from 'viem/chains'

const qAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])

const CHAINS = [
  {
    name: 'BNB Chain', chainId: 56,
    client: createPublicClient({ chain: bsc, transport: http('https://bsc-dataseed.bnbchain.org') }),
    usdt: { a: '0x55d398326f99059fF775485246999027B3197955' as Address, d: 18 },
    x: { sym: 'cNGN', a: '0xa8AEA66B361a8d53e8865c62D142167Af28Af058' as Address, d: 6 },
    amms: [
      { name: 'PancakeSwap v3', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address, fees: [100, 500, 2500, 10000] },
      { name: 'Uniswap v3', quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077' as Address, fees: [100, 500, 3000, 10000] },
    ],
  },
  {
    name: 'Polygon', chainId: 137,
    client: createPublicClient({ chain: polygon, transport: http('https://polygon-rpc.com') }),
    usdt: { a: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as Address, d: 6 },
    x: { sym: 'TESOURO', a: '0xd574b191B5a00262Ff19953d3CE25543AB7C8098' as Address, d: 6 },
    amms: [
      { name: 'Uniswap v3', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as Address, fees: [100, 500, 3000, 10000] },
    ],
  },
]

async function amm(c: any, quoter: Address, fees: number[], tin: Address, tout: Address, amt: bigint) {
  let best: bigint | null = null
  for (const fee of fees) {
    try {
      const { result } = await c.simulateContract({ address: quoter, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin, tokenOut: tout, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (best === null || result[0] > best) best = result[0]
    } catch {}
  }
  return best
}
async function textile(chainId: number, tin: Address, tout: Address, amt: bigint): Promise<bigint | string> {
  try {
    const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId, sellToken: tin, buyToken: tout, sellAmount: amt.toString() }),
    })
    const j: any = await r.json()
    if (!r.ok) return 'no corridor'
    return j.data.status === 'preview' ? BigInt(j.data.buyAmount) : `no quote (${j.data.reason})`
  } catch { return 'error' }
}

for (const ch of CHAINS) {
  console.log(`\n== ${ch.name}: ${ch.x.sym} / USDT ==`)
  for (const size of ['20', '100', '500']) {
    const amt = parseUnits(size, ch.usdt.d)
    const toUsd = (v: bigint) => Number(formatUnits(v, ch.usdt.d))
    const tb = await textile(ch.chainId, ch.usdt.a, ch.x.a, amt)        // buy X on Textile
    for (const a of ch.amms) {
      // Route A: buy on AMM, sell on Textile
      const a1 = await amm(ch.client, a.quoter, a.fees, ch.usdt.a, ch.x.a, amt)
      const a2 = a1 !== null ? await textile(ch.chainId, ch.x.a, ch.usdt.a, a1) : 'no pool'
      const A = a1 === null ? 'no pool' : typeof a2 === 'bigint' ? `${((toUsd(a2) / Number(size) - 1) * 1e4).toFixed(1)} bps ($${(toUsd(a2) - Number(size)).toFixed(3)})` : `Textile ${a2}`
      // Route B: buy on Textile, sell on AMM
      const b2 = typeof tb === 'bigint' ? await amm(ch.client, a.quoter, a.fees, ch.x.a, ch.usdt.a, tb) : null
      const B = typeof tb !== 'bigint' ? `Textile ${tb}` : b2 === null ? 'no pool' : `${((toUsd(b2) / Number(size) - 1) * 1e4).toFixed(1)} bps ($${(toUsd(b2) - Number(size)).toFixed(3)})`
      console.log(`  $${size.padStart(3)} ${a.name.padEnd(15)} AMM->Textile: ${A.padEnd(30)} Textile->AMM: ${B}`)
    }
  }
}
