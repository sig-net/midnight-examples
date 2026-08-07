// Uniswap V3 constants for the swap flow: the pinned SwapRouter02 + QuoterV2 (Sepolia
// canonical, present on the pinned fork), the exactOutputSingle/approve ABI shapes, and a
// read-only QuoterV2 quote. Mirrors evm-transfer.ts for the swap leg.
import { ethers } from "ethers";
import {
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  asciiPadded,
} from "@sig-net/midnight";

// Uniswap V3 on Sepolia (also present on a Sepolia fork). Router is what the vault's
// approveRouter grants + swap targets; the quoter is a read-only price oracle.
export const UNISWAP_SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
export const UNISWAP_QUOTER_V2 = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";

// exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160)) -> uint256 amountIn.
export const EXACT_OUTPUT_SINGLE_SELECTOR = new Uint8Array([0x50, 0x23, 0xb4, 0xdf]);
// approve(address,uint256) -> bool.
export const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);
// Effectively-unlimited allowance (matches the contract's approveRouter, 2^128-1).
export const MAX_APPROVE = 340282366920938463463374607431768211455n;

// A V3 single-hop swap is ~120-200k gas; the contract fixes this envelope (vault pays).
export const SWAP_GAS_LIMIT = 300_000n;
export const SWAP_MAX_FEE_PER_GAS = 30_000_000_000n;
export const SWAP_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

// exactOutputSingle returns amountIn (the input actually spent). Two schemas, asymmetric:
// the MPC DECODES the swap's uint256 return against the output schema, then RESERIALISES it
// packed as uint64 (the respond schema) into the attestation completeSwap verifies. They must
// byte-match the contract's swapOutputSchema / swapRespondSchema. Exact widths: 38 and 37.
export const SWAP_OUTPUT_SCHEMA = '[{"name":"amountIn","type":"uint256"}]';
export const SWAP_RESPOND_SCHEMA = '[{"name":"amountIn","type":"uint64"}]';
export const SWAP_OUTPUT_SCHEMA_BYTES = SWAP_OUTPUT_SCHEMA.length;
export const SWAP_RESPOND_SCHEMA_BYTES = SWAP_RESPOND_SCHEMA.length;

const QUOTER_ABI = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

/** Whether the Uniswap router is deployed at `evmRpcUrl` (true on Sepolia + the fork). */
export async function uniswapAvailable(evmRpcUrl: string): Promise<boolean> {
  const code = await new ethers.JsonRpcProvider(evmRpcUrl).getCode(UNISWAP_SWAP_ROUTER_02);
  return code !== "0x";
}

/**
 * Live QuoterV2 quote for exactOutputSingle (a read-only `eth_call`, no state change): the
 * `amountIn` needed to receive `amountOut`, and the `amountInMaximum` after applying
 * `slippageBps` (headroom ABOVE the quote). This is what the frontend shows and what the swap
 * circuit binds as the on-chain slippage cap (the router reverts if the real cost exceeds it).
 */
export async function quoteExactOutputSingle(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
  fee: bigint,
  amountOut: bigint,
  slippageBps = 100n, // 1%
): Promise<{ amountIn: bigint; amountInMaximum: bigint }> {
  const quoter = new ethers.Contract(UNISWAP_QUOTER_V2, QUOTER_ABI, new ethers.JsonRpcProvider(evmRpcUrl));
  const [amountIn] = await quoter.quoteExactOutputSingle.staticCall({
    tokenIn,
    tokenOut,
    amount: amountOut,
    fee,
    sqrtPriceLimitX96: 0n,
  });
  const amountInMaximum = (BigInt(amountIn) * (10_000n + slippageBps)) / 10_000n;
  return { amountIn: BigInt(amountIn), amountInMaximum };
}

/** The contract-fixed routing of a swap event (the swap-schema variant of VAULT_MPC_ROUTING). */
export const SWAP_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(SWAP_OUTPUT_SCHEMA, SWAP_OUTPUT_SCHEMA_BYTES),
  respondSerializationSchema: asciiPadded(SWAP_RESPOND_SCHEMA, SWAP_RESPOND_SCHEMA_BYTES),
};
