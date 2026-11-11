// Read-only: Textile vs AMM gaps on Base. Sends NO transactions.
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address } from 'viem'
import { base } from 'viem/chains'

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC ?? 'https://mainnet.base.org') })
const CHAIN_ID = 8453
const USDC = { a: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address, d: 6 }
const XS = [
  { sym: 'cNGN', a: '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F' as Address, d: 6 },
  { sym: 'ZARU', a: '0xE205b4e7Ac03E3f7b2060C3EDf2171AA7126C0d5' as Address, d: 18 },
  { sym: 'TESOURO', a: '0x7ceE47e7B7CD04CF984e8Dd86C42595B5771A9B2' as Address, d: 6 },
]
// Uniswap/Pancake v3 quoters take a fee tier; Aerodrome Slipstream takes a tick spacing instead
const feeAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
const tickAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
const AMMS = [
  { name: 'Uniswap v3', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address, abi: feeAbi, key: 'fee', opts: [100, 500, 3000, 10000] },
  { name: 'PancakeSwap v3', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address, abi: feeAbi, key: 'fee', opts: [100, 500, 2500, 10000] },
  { name: 'Aerodrome CL', quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0' as Address, abi: tickAbi, key: 'tickSpacing', opts: [1, 50, 100, 200] },
]

async function amm(m: (typeof AMMS)[number], tin: Address, tout: Address, amt: bigint) {
  let best: bigint | null = null
  for (const o of m.opts) {
    try {
      const { result } = await client.simulateContract({ address: m.quoter, abi: m.abi as any, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin, tokenOut: tout, amountIn: amt, [m.key]: o, sqrtPriceLimitX96: 0n }] }) as any
      if (best === null || result[0] > best) best = result[0]
    } catch {}
  }
  return best
}
async function textile(tin: Address, tout: Address, amt: bigint): Promise<bigint | string> {
  try {
    const r = await fetch('https://api.textilecredit.com/v2/rfq/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: CHAIN_ID, sellToken: tin, buyToken: tout, sellAmount: amt.toString() }),
    })
    const j: any = await r.json()
    if (!r.ok) return 'no corridor'
    return j.data.status === 'preview' ? BigInt(j.data.buyAmount) : `no quote (${j.data.reason})`
  } catch { return 'error' }
}

const toUsd = (v: bigint) => Number(formatUnits(v, USDC.d))
const fmt = (out: bigint, size: string) => `${((toUsd(out) / Number(size) - 1) * 1e4).toFixed(1)} bps ($${(toUsd(out) - Number(size)).toFixed(3)})`

for (const X of XS) {
  console.log(`\n== Base: ${X.sym} / USDC ==`)
  for (const size of ['20', '100', '500']) {
    const amt = parseUnits(size, USDC.d)
    const tb = await textile(USDC.a, X.a, amt) // buy X on Textile
    for (const m of AMMS) {
      const a1 = await amm(m, USDC.a, X.a, amt) // buy X on AMM
      const a2 = a1 !== null ? await textile(X.a, USDC.a, a1) : 'no pool'
      const A = a1 === null ? 'no pool' : typeof a2 === 'bigint' ? fmt(a2, size) : `Textile ${a2}`
      const b2 = typeof tb === 'bigint' ? await amm(m, X.a, USDC.a, tb) : null
      const B = typeof tb !== 'bigint' ? `Textile ${tb}` : b2 === null ? 'no pool' : fmt(b2, size)
      console.log(`  $${size.padStart(3)} ${m.name.padEnd(15)} AMM->Textile: ${A.padEnd(30)} Textile->AMM: ${B}`)
    }
  }
}
