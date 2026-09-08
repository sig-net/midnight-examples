// The full swap journey as one arrange-stage helper: approve, quote, startSwap, MPC
// signature, broadcast, completeSwap.
import type { RequestIdHex } from "@sig-net/midnight";
import { VAULT_SWAP_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { quoteExactOutputSingle } from "../evm-swap.ts";
import type { VaultSession } from "../vault-session.ts";
import { ensureRouterApproved } from "./approve-router.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { completeSwap } from "./complete-swap.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startSwap } from "./start-swap.ts";

const MINUTE = 60_000;

/** Options for {@link runSwapRoundTrip}. */
export interface SwapRoundTripOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly slippageBps?: bigint;
  // Override the quoted slippage cap. An impossibly LOW value forces the router to revert
  // ("Too much requested"), driving the refund path — used by the swap-refund e2e.
  readonly amountInMaximum?: bigint;
}

/**
 * Full swap round trip against the live stack: ensure the router is approved for tokenIn,
 * quote maxIn, submit the swap (vault-signed, both allocator phases), poll the MPC signature,
 * broadcast the swap tx,
 * poll the attestation, and settle (completeSwap mints the exact amountOut of tokenOut plus
 * the unspent tokenIn as change). The setup pipeline verifies the Uniswap router is deployed on
 * the fork before any flow runs. Requires the caller to already HOLD amountInMaximum of the
 * tokenIn vault coin (run a deposit first). Returns amountOut (minted) and amountIn (the attested
 * spend).
 *
 * @param session - The vault session.
 * @param opts - Swap parameters (tokenOut, fee, exact amountOut, optional slippage/cap override).
 * @returns The request id, amountOut minted, amountIn spent, and refund flag.
 */
export async function runSwapRoundTrip(
  session: VaultSession,
  opts: SwapRoundTripOptions,
): Promise<{
  requestId: RequestIdHex;
  amountOut: bigint;
  amountIn: bigint;
  refunded: boolean;
}> {
  const context = await session.vaultContext();

  await ensureRouterApproved(session);

  const { amountIn: quoted, amountInMaximum: quotedMax } = await quoteExactOutputSingle(
    context.evmRpcUrl,
    context.erc20Address,
    opts.tokenOut,
    opts.fee,
    opts.amountOut,
    opts.slippageBps ?? 100n,
  );
  const amountInMaximum = opts.amountInMaximum ?? quotedMax;
  console.log(
    `quote: ~${String(quoted)} ${context.erc20Address} -> ${String(opts.amountOut)} ${opts.tokenOut} (max ${String(amountInMaximum)})`,
  );

  // No EVM nonce is read from the chain: startSwap runs both phases and the vault's allocator
  // proves the tx nonce out of the slot phase 1 landed in.
  const { requestId, coinNonce } = await startSwap(context, {
    tokenOut: opts.tokenOut,
    fee: opts.fee,
    amountOut: opts.amountOut,
    amountInMaximum,
  });

  // The swap tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert (slippage / liquidity / an impossible amountInMaximum) is a valid outcome
  // the MPC attests as a failure and completeSwap settles via refund — not a broadcast error.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SWAP_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  // The surrendered coin's nonce is what proves swapper-hood at settle time: the settle-view
  // commitment is the phase-1 request key, requestCommitment(secret, coinNonce).
  const { amountIn, refunded } = await completeSwap(context, requestId, coinNonce);
  return { requestId, amountOut: opts.amountOut, amountIn, refunded };
}
