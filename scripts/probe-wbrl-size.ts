// Read-only: how much wBRL will Textile sell right now, and what does each size earn through the v4 pool?
import { createPublicClient, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, parseUnits, type Address } from 'viem'
import { celo } from 'viem/chains'
const client = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC ?? 'https://forno.celo.org') })
const POOL_ID = '0xa7e41e2c1da9a6ab0a0d7e10dc1c23581c6cd9e31b449ab3a13683fa389d54f9'
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'
const WBRL = '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0'
const pm = parseAbi(['function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'])
const q = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
const r = await client.readContract({ address: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9', abi: pm, functionName: 'poolKeys', args: [POOL_ID.slice(0, 52) as `0x${string}`] })
const key = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] }
console.log(`v4 pool fee ${key.fee / 100} bps, hook ${key.hooks}\n`)

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
async function textile(amt: bigint) {
  const res = await fetch('https://api.textilecredit.com/v2/rfq/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chainId: 42220, sellToken: USDT, buyToken: WBRL, sellAmount: amt.toString() }) })
  const j: any = await res.json().catch(() => ({}))
  if (j?.data?.status === 'preview') return { out: BigInt(j.data.buyAmount) }
  return { reason: `${res.status} ${j?.data?.reason ?? j?.error?.details?.reason ?? j?.error?.code ?? JSON.stringify(j).slice(0, 80)}` }
}
async function v4sell(wbrl: bigint) {
  try {
    const { result } = await client.simulateContract({ address: '0x28566da1093609182dff2cb2a91cfd72e61d66cd', abi: q, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: WBRL.toLowerCase() === key.currency0.toLowerCase(), exactAmount: wbrl, hookData: '0x' }] })
    return result[0]
  } catch { return null }
}
console.log('Size    Textile sells wBRL?          wBRL per $        v4 returns USDC     Profit (before USDC->USDT)')
for (const usd of [10, 20, 30, 40, 50, 60, 75, 100, 150, 250]) {
  const amt = parseUnits(String(usd), 6)
  const t = await textile(amt)
  if (!('out' in t)) { console.log(`$${String(usd).padStart(4)}   no: ${t.reason}`); await sleep(1200); continue }
  const usdc = await v4sell(t.out!)
  const rate = Number(formatUnits(t.out!, 18)) / usd
  const back = usdc !== null ? Number(formatUnits(usdc, 6)) : NaN
  console.log(`$${String(usd).padStart(4)}   yes                          ${rate.toFixed(4).padStart(8)}          ${isFinite(back) ? '$' + back.toFixed(3) : 'no quote'}            ${isFinite(back) ? ((back >= usd ? '+$' : '-$') + Math.abs(back - usd).toFixed(3) + `  (${((back / usd - 1) * 1e4).toFixed(0)} bps)`) : ''}`)
  await sleep(1200)
}
