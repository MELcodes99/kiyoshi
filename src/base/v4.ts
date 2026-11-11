// Pure Uniswap v4 helpers: pool ids and Universal Router calldata. No network, unit tested.
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbi, type Address, type Hex } from 'viem'

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

const KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

export const SWAP_PARAMS_ABI = [{
  type: 'tuple',
  components: [
    { name: 'poolKey', type: 'tuple', components: KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const

export const V4_SWAP = 0x10
export const ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const
export const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

export const poolId = (k: PoolKey) => keccak256(encodeAbiParameters([{ type: 'tuple', components: KEY_COMPONENTS }], [k]))

/** Universal Router call for one exact-input swap in a v4 pool; reverts onchain if output < minOut. */
export function encodeExactInSingle(key: PoolKey, tokenIn: Address, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase()
  const tokenOut = zeroForOne ? key.currency1 : key.currency0
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL])
  const swapParams = encodeAbiParameters(SWAP_PARAMS_ABI, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }])
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenIn, amountIn])
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenOut, minOut])
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]])
  return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [encodePacked(['uint8'], [V4_SWAP]), [input], deadline] })
}
