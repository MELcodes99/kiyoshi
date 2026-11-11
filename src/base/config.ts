import 'dotenv/config'
import type { Address } from 'viem'

export const BASE_CHAIN_ID = 8453
export const BASE_RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org'

// Textile settlement contract on Base (docs.textilecredit.com/protocol/address-book)
export const BASE_TEXTILE_REACTOR: Address = '0xEb5A29F869FF084B3Fce18d3487a38A56feDC59E'

// Uniswap v4 on Base (developers.uniswap.org v4 deployments)
export const V4 = {
  QUOTER: '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address,
  ROUTER: '0x6ff5693b99212da76ad316178a184ab56d299b43' as Address, // Universal Router
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
}

export const BASE_TOKENS = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address, decimals: 6 },
  cNGN: { address: '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F' as Address, decimals: 6 },
} as const
export type BaseTokenKey = keyof typeof BASE_TOKENS

// cNGN/USDC Uniswap v4 pool on Base: 0.15% fee, tick spacing 30, no hook
export const CNGN_POOL = {
  id: '0x84fa97768196067f0e5aa157709039a3897e219cba3002d9ad38bf44e300fe93',
  key: {
    currency0: BASE_TOKENS.cNGN.address,
    currency1: BASE_TOKENS.USDC.address,
    fee: 1500,
    tickSpacing: 30,
    hooks: '0x0000000000000000000000000000000000000000' as Address,
  },
}
