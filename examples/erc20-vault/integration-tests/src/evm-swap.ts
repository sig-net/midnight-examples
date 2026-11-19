// Uniswap V3 constants for the swap flow: the pinned SwapRouter02 + QuoterV2 (Sepolia
// canonical, present on the pinned fork), the exactOutputSingle ABI shape, and a
// read-only QuoterV2 quote. Mirrors evm-transfer.ts for the swap leg.
import { UNISWAP_SWAP_ROUTER_02 } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { ContractReadMethod } from "@sig-net/midnight-examples-test-harness";
import { ethers } from "ethers";

/** Uniswap V3 QuoterV2 on Sepolia — a read-only price oracle. */
export const UNISWAP_QUOTER_V2 = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";

/** exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160)) selector. */
export const EXACT_OUTPUT_SINGLE_SELECTOR = new Uint8Array([0x50, 0x23, 0xb4, 0xdf]);

/** The USDC/EURC pool's fee tier the swap suites trade through. */
export const SWAP_FEE = 500n;
/**
 * The swap suite's exactOutput: receive EXACTLY 1 EURC. The fork pool's price is arbitrary (thin
 * testnet liquidity, not ~1:1), so the input cap is sized from a LIVE quote, with generous
 * headroom so the swap fits and leaves change.
 */
export const SWAP_AMOUNT_OUT = 1_000_000n;
const SWAP_CAP_SLIPPAGE_BPS = 1000n;
/** The swap refund suite's exactOutput: ask for EXACTLY 3 EURC while capping the spend below its cost. */
export const SWAP_REFUND_AMOUNT_OUT = 3_000_000n;

const QUOTER_ABI = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

/**
 * Whether the Uniswap router is deployed at `evmRpcUrl` (true on Sepolia + the fork).
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint to probe.
 * @returns True when the SwapRouter02 has code at `evmRpcUrl`.
 */
export async function uniswapAvailable(evmRpcUrl: string): Promise<boolean> {
  const code = await new ethers.JsonRpcProvider(evmRpcUrl).getCode(UNISWAP_SWAP_ROUTER_02);
  return code !== "0x";
}

/**
 * Live QuoterV2 quote for exactOutputSingle (a read-only `eth_call`, no state change): the
 * `amountIn` needed to receive `amountOut`, and the `amountInMaximum` after applying
 * `slippageBps` (headroom ABOVE the quote). This is what the frontend shows and what the swap
 * circuit binds as the on-chain slippage cap (the router reverts if the real cost exceeds it).
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint.
 * @param tokenIn - The token being sold.
 * @param tokenOut - The token being bought.
 * @param fee - The Uniswap V3 pool fee tier.
 * @param amountOut - The exact output amount to receive.
 * @param slippageBps - Basis points of headroom above the quote for the cap (default 100 = 1%).
 * @returns The quoted amountIn and the amountInMaximum cap after slippage.
 */
export async function quoteExactOutputSingle(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
  fee: bigint,
  amountOut: bigint,
  slippageBps = 100n, // 1%
): Promise<{ amountIn: bigint; amountInMaximum: bigint }> {
  const quoter = new ethers.Contract(
    UNISWAP_QUOTER_V2,
    QUOTER_ABI,
    new ethers.JsonRpcProvider(evmRpcUrl),
  );
  const [amountIn] = await quoter
    .getFunction<ContractReadMethod<[bigint, bigint, bigint, bigint]>>("quoteExactOutputSingle")
    .staticCall({ tokenIn, tokenOut, amount: amountOut, fee, sqrtPriceLimitX96: 0n });
  const amountInMaximum = (amountIn * (10_000n + slippageBps)) / 10_000n;
  return { amountIn, amountInMaximum };
}

/**
 * The input cap the swap suite surrenders: the live quote for {@link SWAP_AMOUNT_OUT} plus
 * {@link SWAP_CAP_SLIPPAGE_BPS} of headroom.
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint.
 * @param tokenIn - The sold ERC20.
 * @param tokenOut - The bought ERC20.
 * @returns The quoted `amountInMaximum`.
 */
export async function swapQuotedCap(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
): Promise<bigint> {
  return (
    await quoteExactOutputSingle(
      evmRpcUrl,
      tokenIn,
      tokenOut,
      SWAP_FEE,
      SWAP_AMOUNT_OUT,
      SWAP_CAP_SLIPPAGE_BPS,
    )
  ).amountInMaximum;
}

/**
 * The input cap the swap refund suite's doomed swap surrenders: half the live quote for
 * {@link SWAP_REFUND_AMOUNT_OUT}, below its real cost whatever the fork pool's price.
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint.
 * @param tokenIn - The sold ERC20.
 * @param tokenOut - The bought ERC20.
 * @returns The `amountInMaximum` the router must revert above.
 */
export async function swapRefundDoomedCap(
  evmRpcUrl: string,
  tokenIn: string,
  tokenOut: string,
): Promise<bigint> {
  return (
    (await quoteExactOutputSingle(evmRpcUrl, tokenIn, tokenOut, SWAP_FEE, SWAP_REFUND_AMOUNT_OUT))
      .amountIn / 2n
  );
}
