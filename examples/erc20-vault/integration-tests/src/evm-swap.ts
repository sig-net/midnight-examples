// Uniswap V3 constants for the swap flow: the pinned SwapRouter02 + QuoterV2 (Sepolia
// canonical, present on the pinned fork), the exactInputSingle/approve ABI shapes, and a
// read-only QuoterV2 quote. Mirrors evm-transfer.ts for the swap leg.
import { ethers } from "ethers";

// Uniswap V3 on Sepolia (also present on a Sepolia fork). Router is what the vault's
// approveRouter grants + swap targets; the quoter is a read-only price oracle.
export const UNISWAP_SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
export const UNISWAP_QUOTER_V2 = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";

// exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) -> uint256.
export const EXACT_INPUT_SINGLE_SELECTOR = new Uint8Array([0x04, 0xe4, 0x5a, 0xaf]);
// approve(address,uint256) -> bool.
export const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
// Effectively-unlimited allowance (matches the contract's approveRouter, 2^128-1).
export const MAX_APPROVE = 340282366920938463463374607431768211455n;

// A V3 single-hop swap is ~120-200k gas; the contract fixes this envelope (vault pays).
export const SWAP_GAS_LIMIT = 300_000n;
export const SWAP_MAX_FEE_PER_GAS = 30_000_000_000n;
export const SWAP_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

// The exactInputSingle result schema (must byte-match the contract's swapResponseSchema).
export const SWAP_RESULT_SCHEMA = '[{"name":"amountOut","type":"uint256"}]';

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

/** Whether the Uniswap router is deployed at `evmRpcUrl` (true on Sepolia + the fork). */
export async function uniswapAvailable(evmRpcUrl: string): Promise<boolean> {
  const code = await new ethers.JsonRpcProvider(evmRpcUrl).getCode(UNISWAP_SWAP_ROUTER_02);
  return code !== "0x";
}

/**
 * Live QuoterV2 quote for exactInputSingle (a read-only `eth_call`, no state change), and
 * the `amountOutMin` after applying `slippageBps`. This is what the frontend shows and what
 * the swap circuit binds as the on-chain slippage floor.
 */
export async function quoteExactInputSingle(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
  fee: bigint,
  amountIn: bigint,
  slippageBps = 100n, // 1%
): Promise<{ amountOut: bigint; amountOutMin: bigint }> {
  const quoter = new ethers.Contract(UNISWAP_QUOTER_V2, QUOTER_ABI, new ethers.JsonRpcProvider(evmRpcUrl));
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  });
  const amountOutMin = (BigInt(amountOut) * (10_000n - slippageBps)) / 10_000n;
  return { amountOut: BigInt(amountOut), amountOutMin };
}

import {
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  asciiPadded,
} from "@sig-net/midnight";

/** Byte width of the swap schema (Compact `Bytes<39>`). */
export const SWAP_SCHEMA_BYTES = SWAP_RESULT_SCHEMA.length;

/** The contract-fixed routing of a swap event (the swap-schema variant of VAULT_MPC_ROUTING). */
export const SWAP_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(SWAP_RESULT_SCHEMA, SWAP_SCHEMA_BYTES),
  respondSerializationSchema: asciiPadded(SWAP_RESULT_SCHEMA, SWAP_SCHEMA_BYTES),
};
