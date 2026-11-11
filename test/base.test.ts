import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeAbiParameters, decodeFunctionData } from 'viem'
import { BASE_TOKENS, CNGN_POOL } from '../src/base/config.js'
import { encodeExactInSingle, poolId, routerAbi, SWAP_PARAMS_ABI } from '../src/base/v4.js'

const CNGN = BASE_TOKENS.cNGN.address.toLowerCase()
const USDC = BASE_TOKENS.USDC.address.toLowerCase()

function decode(data: `0x${string}`) {
  const { args } = decodeFunctionData({ abi: routerAbi, data })
  const [commands, inputs, deadline] = args as any
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]) as any
  const [swap] = decodeAbiParameters(SWAP_PARAMS_ABI, params[0]) as any
  const [settleToken, settleMax] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]) as any
  const [takeToken, takeMin] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]) as any
  return { commands, inputs, deadline, actions, params, swap, settleToken, settleMax, takeToken, takeMin }
}

test('cNGN/USDC pool key hashes to the live Base pool id', () => assert.equal(poolId(CNGN_POOL.key).toLowerCase(), CNGN_POOL.id))
test('pool currencies are sorted as Uniswap v4 requires', () => assert.ok(CNGN_POOL.key.currency0.toLowerCase() < CNGN_POOL.key.currency1.toLowerCase()))

test('router call is one V4_SWAP: swap exact in, settle all, take all', () => {
  const d = decode(encodeExactInSingle(CNGN_POOL.key, BASE_TOKENS.cNGN.address, 1000n, 900n, 123n))
  assert.equal(d.commands, '0x10')
  assert.equal(d.inputs.length, 1)
  assert.equal(d.actions, '0x060c0f')
  assert.equal(d.params.length, 3)
  assert.equal(d.deadline, 123n)
})
test('selling cNGN: zeroForOne, pays cNGN, takes USDC with the minimum enforced', () => {
  const d = decode(encodeExactInSingle(CNGN_POOL.key, BASE_TOKENS.cNGN.address, 1000n, 900n, 1n))
  assert.equal(d.swap.zeroForOne, true)
  assert.equal(d.swap.amountIn, 1000n)
  assert.equal(d.swap.amountOutMinimum, 900n)
  assert.equal(d.settleToken.toLowerCase(), CNGN); assert.equal(d.settleMax, 1000n)
  assert.equal(d.takeToken.toLowerCase(), USDC); assert.equal(d.takeMin, 900n)
})
test('buying cNGN with USDC: oneForZero, pays USDC, takes cNGN', () => {
  const d = decode(encodeExactInSingle(CNGN_POOL.key, BASE_TOKENS.USDC.address, 5_000_000n, 6_900_000_000n, 1n))
  assert.equal(d.swap.zeroForOne, false)
  assert.equal(d.settleToken.toLowerCase(), USDC)
  assert.equal(d.takeToken.toLowerCase(), CNGN); assert.equal(d.takeMin, 6_900_000_000n)
})
