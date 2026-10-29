// Read-only: Mento vs Uniswap X/USDm pools on Celo, with pool depth. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from '../src/wallet.js'

const USDT: Address = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'
const USDm: Address = '0x765DE816845861e75A25fCA122bb6898B8B1282a'
const BROKER: Address = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'
const BIPOOL: Address = '0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901'
const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const FACTORY: Address = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc'
const ZERO = '0x0000000000000000000000000000000000000000'
const erc20 = parseAbi(['function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)'])
const qAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
const fAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const bAbi = parseAbi(['function getAmountOut(address,bytes32,address,address,uint256) view returns (uint256)'])
const pAbi = parseAbi(['function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])'])
const FEES = [100, 500, 3000, 10000]

async function uni(tin: Address, tout: Address, amt: bigint) {
  let best: bigint | null = null
  for (const fee of FEES) {
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: qAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: tin, tokenOut: tout, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] })
      if (best === null || result[0] > best) best = result[0]
    } catch {}
  }
  return best
}
async function mento(id: `0x${string}`, tin: Address, tout: Address, amt: bigint) {
  try { return await pub.readContract({ address: BROKER, abi: bAbi, functionName: 'getAmountOut', args: [BIPOOL, id, tin, tout, amt] }) } catch { return null }
}
// depth: USDm held across all X/USDm pools, plus X held, valued in USDm at Mento's rate
async function depth(id: `0x${string}`, X: Address) {
  let usdm = 0n, x = 0n
  for (const fee of FEES) {
    const pool = await pub.readContract({ address: FACTORY, abi: fAbi, functionName: 'getPool', args: [X, USDm, fee] })
    if (pool === ZERO) continue
    const [bu, bx] = await Promise.all([
      pub.readContract({ address: USDm, abi: erc20, functionName: 'balanceOf', args: [pool] }),
      pub.readContract({ address: X, abi: erc20, functionName: 'balanceOf', args: [pool] }),
    ])
    usdm += bu; x += bx
  }
  const xInUsdm = x > 0n ? (await mento(id, X, USDm, x)) ?? 0n : 0n
  return Number(formatUnits(usdm + xInUsdm, 18))
}
const bps = (out: bigint, size: number) => (Number(formatUnits(out, 18)) / size - 1) * 1e4

// cost of getting in and out of USDm from USDT
const inU = await uni(USDT, USDm, parseUnits('100', 6))
const backT = inU ? await uni(USDm, USDT, inU) : null
console.log(`USDT -> USDm -> USDT round trip on Uniswap ($100): ${backT ? ((Number(formatUnits(backT, 6)) / 100 - 1) * 1e4).toFixed(1) + ' bps' : 'n/a'}`)
console.log('A Mento loop must beat this to be worth it if Kiyoshi starts from USDT.\n')

const exchanges = await pub.readContract({ address: BIPOOL, abi: pAbi, functionName: 'getExchanges' })
console.log('Currency  Uniswap depth   Size   Loop 1 (Mento->Uni)   Loop 2 (Uni->Mento)')
for (const ex of exchanges) {
  const [a, b] = ex.assets
  const X = a.toLowerCase() === USDm.toLowerCase() ? b : a
  if (a.toLowerCase() !== USDm.toLowerCase() && b.toLowerCase() !== USDm.toLowerCase()) continue
  const sym = String(await pub.readContract({ address: X, abi: erc20, functionName: 'symbol' }).catch(() => X.slice(0, 8)))
  const d = await depth(ex.exchangeId, X)
  for (const size of [10, 50, 200]) {
    const amt = parseUnits(String(size), 18)
    const m1 = await mento(ex.exchangeId, USDm, X, amt)
    const u1 = m1 !== null ? await uni(X, USDm, m1) : null
    const u2 = await uni(USDm, X, amt)
    const m2 = u2 !== null ? await mento(ex.exchangeId, X, USDm, u2) : null
    const L1 = u1 !== null ? bps(u1, size).toFixed(1) + ' bps' : m1 === null ? 'Mento failed' : 'no X/USDm pool'
    const L2 = m2 !== null ? bps(m2, size).toFixed(1) + ' bps' : u2 === null ? 'no X/USDm pool' : 'Mento failed'
    console.log(`${(size === 10 ? sym : '').padEnd(9)} ${(size === 10 ? '$' + Math.round(d).toLocaleString() : '').padStart(13)}   $${String(size).padStart(3)}   ${L1.padStart(18)}    ${L2.padStart(18)}`)
  }
}
