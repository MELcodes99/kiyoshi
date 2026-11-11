import { parseAbi, formatUnits, parseUnits } from 'viem'
import { pub } from '../src/wallet.js'
import { uniQuote } from '../src/uniswap.js'
import { TOKENS } from '../src/config.js'
const POOL = '0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F'
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const [b, u] = await Promise.all([
  pub.readContract({ address: TOKENS.wBRL.address, abi: erc20, functionName: 'balanceOf', args: [POOL] }),
  pub.readContract({ address: TOKENS.USDT.address, abi: erc20, functionName: 'balanceOf', args: [POOL] }),
])
console.log('Old pool holds:', formatUnits(b, 18), 'wBRL and', formatUnits(u, 6), 'USDT')
for (const usd of ['20', '100']) {
  const q = await uniQuote('USDT', 'wBRL', parseUnits(usd, 6))
  console.log(`Best Uniswap quote for $${usd}:`, q ? `${formatUnits(q.out, 18)} wBRL (fee tier ${q.fee})` : 'NO QUOTE: no usable pool')
}
