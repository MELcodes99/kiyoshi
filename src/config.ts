import 'dotenv/config'
import type { Address } from 'viem'

// Loops House attribution tag for Agents on Open Rails. Every tx must carry it.
export const ATTRIBUTION_TAG = 'celo_f6214d29d540'

export const CHAIN_ID = 42220
export const RPC_URL = process.env.CELO_RPC ?? 'https://forno.celo.org'
export const TEXTILE_API = 'https://api.textilecredit.com'

// From docs.textilecredit.com/protocol/address-book (Celo 42220)
export const TEXTILE_REACTOR: Address = '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'

export const TOKENS = {
  cNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f' as Address, decimals: 6 },
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address, decimals: 6 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address, decimals: 6 },
} as const

export type TokenKey = keyof typeof TOKENS
