// Read-only: look for Uniswap vs Textile gaps on more Celo corridors. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from '../src/wallet.js'
import { preview } from '../src/textile.js'

const USDT = { a: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address, d: 6 }
const CANDIDATES: Record<string, { a: Address; d: number }> = {
  USDC: { a: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', d: 6 },
  IDRX: { a: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', d: 2 },
  CELO: { a: '0x471EcE3750Da237f93B8E339c536989b8978a438', d: 18 },
  wCOP: { a: '0x8a1d45e102e886510e891d2ec656a708991e2d76', d: 18 },
  wMXN: { a: '0x337e7456b420bd3481e7fa61fa9850343d610d34', d: 18 },
  USDm: { a: '0x765DE816845861e75A25fCA122bb6898B8B1282a', d: 18 },
}
const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const qAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])

async function uni(tin: Address, tout: Address, amt: bigint) {
  let best: { out: bigint; fee: number } | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin, tokenOut: tout, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (!best || result[0] > best.out) best = { out: result[0], fee }
    } catch {}
  }
  return best
}
async function tex(tin: Address, tout: Address, amt: bigint): Promise<bigint | string> {
  try {
    const p = await preview({ sellToken: tin, buyToken: tout, sellAmount: amt.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : `no quote (${p.reason})`
  } catch (e: any) { return 'no corridor' }
}
const usd = (v: bigint) => Number(formatUnits(v, 6))

for (const [sym, X] of Object.entries(CANDIDATES)) {
  console.log(`\n== ${sym} ==`)
  for (const size of ['20', '100']) {
    const amt = parseUnits(size, 6)
    // Route A: buy X on Uniswap, sell on Textile
    const a1 = await uni(USDT.a, X.a, amt)
    const a2 = a1 ? await tex(X.a, USDT.a, a1.out) : 'no uniswap pool'
    const aLine = a1 && typeof a2 === 'bigint'
      ? `$${(usd(a2) - Number(size)).toFixed(4)} (${((usd(a2) / Number(size) - 1) * 1e4).toFixed(1)} bps)`
      : (a1 ? `Textile ${a2}` : 'no Uniswap pool')
    // Route B: buy X on Textile, sell on Uniswap
    const b1 = await tex(USDT.a, X.a, amt)
    const b2 = typeof b1 === 'bigint' ? await uni(X.a, USDT.a, b1) : null
    const bLine = typeof b1 === 'bigint' && b2
      ? `$${(usd(b2.out) - Number(size)).toFixed(4)} (${((usd(b2.out) / Number(size) - 1) * 1e4).toFixed(1)} bps)`
      : (typeof b1 !== 'bigint' ? `Textile ${b1}` : 'no Uniswap pool')
    console.log(`  $${size.padStart(3)}  Uniswap->Textile: ${aLine}`)
    console.log(`        Textile->Uniswap: ${bLine}`)
  }
}
