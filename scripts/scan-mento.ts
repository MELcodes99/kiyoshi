// Read-only: Mento (oracle-priced) vs Uniswap v3 loops on Celo. Sends NO transactions.
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { pub } from '../src/wallet.js'

const USDT: Address = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'
const USDm: Address = '0x765DE816845861e75A25fCA122bb6898B8B1282a'
const BROKER: Address = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'
const BIPOOL: Address = '0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901'
const QUOTER: Address = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8'
const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const qAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'])
const bAbi = parseAbi(['function getAmountOut(address,bytes32,address,address,uint256) view returns (uint256)'])
const pAbi = parseAbi(['function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])'])

const meta = new Map<string, { sym: string; d: number }>()
async function info(a: Address) {
  const k = a.toLowerCase()
  if (!meta.has(k)) {
    const [sym, d] = await Promise.all([
      pub.readContract({ address: a, abi: erc20, functionName: 'symbol' }).catch(() => a.slice(0, 8)),
      pub.readContract({ address: a, abi: erc20, functionName: 'decimals' }).catch(() => 18),
    ])
    meta.set(k, { sym: String(sym), d: Number(d) })
  }
  return meta.get(k)!
}
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
async function mento(id: `0x${string}`, tin: Address, tout: Address, amt: bigint): Promise<bigint | string> {
  try { return await pub.readContract({ address: BROKER, abi: bAbi, functionName: 'getAmountOut', args: [BIPOOL, id, tin, tout, amt] }) }
  catch (e: any) { return 'error: ' + String(e.shortMessage ?? e.message).split('\n').slice(-1)[0].slice(0, 60) }
}
const bps = (out: bigint, size: number) => `${((Number(formatUnits(out, 6)) / size - 1) * 1e4).toFixed(1)} bps`

const exchanges = await pub.readContract({ address: BIPOOL, abi: pAbi, functionName: 'getExchanges' })
console.log(`Mento exchanges on Celo: ${exchanges.length}`)
for (const ex of exchanges) {
  const [a, b] = ex.assets
  const [ia, ib] = await Promise.all([info(a), info(b)])
  // the non-USDm side is the asset we try to loop through
  const isUsdmA = a.toLowerCase() === USDm.toLowerCase(), isUsdmB = b.toLowerCase() === USDm.toLowerCase()
  if (!isUsdmA && !isUsdmB) { console.log(`\n${ia.sym} / ${ib.sym}  (not a USDm pair, skipped)`); continue }
  const X = isUsdmA ? b : a, ix = isUsdmA ? ib : ia
  const live = await mento(ex.exchangeId, USDm, X, parseUnits('10', 18))
  console.log(`\n${ix.sym} / USDm   Mento: ${typeof live === 'bigint' ? 'quoting' : live}`)
  if (typeof live !== 'bigint') continue
  for (const size of [20, 100]) {
    const amt = parseUnits(String(size), 6)
    // Loop A: USDT -> USDm (Uniswap) -> X (Mento) -> USDT (Uniswap)
    const a1 = await uni(USDT, USDm, amt)
    const a2 = a1 ? await mento(ex.exchangeId, USDm, X, a1) : null
    const a3 = typeof a2 === 'bigint' ? await uni(X, USDT, a2) : null
    // Loop B: USDT -> X (Uniswap) -> USDm (Mento) -> USDT (Uniswap)
    const b1 = await uni(USDT, X, amt)
    const b2 = b1 ? await mento(ex.exchangeId, X, USDm, b1) : null
    const b3 = typeof b2 === 'bigint' ? await uni(USDm, USDT, b2) : null
    const A = a3 ? bps(a3, size) : !a1 ? 'no USDT/USDm pool' : 'no ' + ix.sym + '/USDT pool'
    const B = b3 ? bps(b3, size) : !b1 ? 'no ' + ix.sym + '/USDT pool' : 'Mento leg failed'
    console.log(`  $${String(size).padStart(3)}  A (USDm->Mento->${ix.sym}->USDT): ${A.padEnd(24)}  B (${ix.sym}->Mento->USDm->USDT): ${B}`)
  }
}
