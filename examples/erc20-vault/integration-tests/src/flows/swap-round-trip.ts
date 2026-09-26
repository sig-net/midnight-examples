// The full swap journey as one arrange-stage helper: approve, quote, startSwap, MPC
// signature, broadcast, completeSwap.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_SWAP_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip } from "@sig-net/midnight-examples-test-harness";

import { logTokenAmount } from "../evm-logging.ts";
import { quoteExactOutputSingle } from "../evm-swap.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultSession } from "../vault-session.ts";
import { ensureRouterApproved } from "./approve-router.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSwapOutcome, settleSwap } from "./complete-swap.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startSwap } from "./start-swap.ts";

/** Options for {@link runSwapRoundTrip}. */
export interface SwapRoundTripOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly slippageBps?: bigint;
  // Override the quoted slippage cap. An impossibly LOW value forces the router to revert
  // ("Too much requested"), driving the refund path — used by the swap-refund e2e.
  readonly amountInMaximum?: bigint;
  /**
   * Resume from an existing request instead of quoting and calling {@link startSwap},
   * for recovering a run that died mid-round-trip (e.g. the proof server OOM-killed at
   * the settle). Every later leg is naturally idempotent: the signature response and
   * attestation persist on the signet ledger, `broadcastEvm` short-circuits on a mined
   * swap, and an already-settled request skips the settle.
   */
  readonly reuseRequestId?: RequestIdHex;
}

/** What {@link runSwapRoundTrip} hands back to the flow file. */
export interface SwapRoundTripResult {
  /** The swap request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /** The exact tokenOut amount the swap requested. */
  readonly amountOut: bigint;
  /** The attested tokenIn spent (0 on refund). */
  readonly amountIn: bigint;
  /** Whether the MPC attested the swap as failed, so the settle refunded tokenIn. */
  readonly refunded: boolean;
  /**
   * Whether THIS run executed the settle. `false` means the request was
   * already settled by a prior run (rerun against a kept contract address):
   * the mint happened back then, so effects like a balance delta are not
   * observable in this run.
   */
  readonly settled: boolean;
}

/**
 * Full swap round trip against the live stack: ensure the router is approved for tokenIn,
 * quote maxIn, submit the swap (vault-signed), poll the MPC signature, broadcast the swap tx,
 * poll the attestation, and settle (completeSwap mints the exact amountOut of tokenOut plus
 * the unspent tokenIn as change). The setup pipeline verifies the Uniswap router is deployed on
 * the fork before any flow runs. Requires the caller to already HOLD amountInMaximum of the
 * tokenIn vault coin (run a deposit first). Rerun-tolerant against kept addresses: an
 * already-settled request logs a skip instead of failing.
 *
 * @param session - The vault session.
 * @param opts - Swap parameters (tokenOut, fee, exact amountOut, optional slippage/cap override)
 *   and optional resume id.
 * @returns The request id, amountOut minted, amountIn spent, refund flag, and whether this run
 *   executed the settle.
 * @throws {Error} If any leg times out, or the resume id is not a request id.
 */
export async function runSwapRoundTrip(
  session: VaultSession,
  opts: SwapRoundTripOptions,
): Promise<SwapRoundTripResult> {
  const context = await session.vaultContext();

  await ensureRouterApproved(session);

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("swap", `resuming swap round trip from existing request ${requestId}`);
  } else {
    const { amountIn: quoted, amountInMaximum: quotedMax } = await quoteExactOutputSingle(
      context.evmRpcUrl,
      context.erc20Address,
      opts.tokenOut,
      opts.fee,
      opts.amountOut,
      opts.slippageBps ?? 100n,
    );
    const amountInMaximum = opts.amountInMaximum ?? quotedMax;
    await logTokenAmount(
      context.evmRpcUrl,
      context.erc20Address,
      context.evmVaultAddress,
      quoted,
      "swap quoted input",
    );
    await logTokenAmount(
      context.evmRpcUrl,
      context.erc20Address,
      context.evmVaultAddress,
      amountInMaximum,
      "swap maximum input",
    );

    requestId = await startSwap(context, {
      tokenOut: opts.tokenOut,
      fee: opts.fee,
      amountOut: opts.amountOut,
      amountInMaximum,
    });
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`swap request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // The swap tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert (slippage / liquidity / an impossible amountInMaximum) is a valid outcome
  // the MPC attests as a failure and completeSwap settles via refund — not a broadcast error.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SWAP_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const outcome = await pollSwapOutcome(context, { requestId });

  // Rerun against a kept contract address: a prior run may have already
  // settled this request (settling consumes its pending-swap marker): the
  // minted coins are already in the wallet, so skip instead of failing.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.swapSettleViews.member(requestIdBytes(requestId))) {
    logSkip("completeSwap", `swap ${requestId} already settled (no pending marker)`);
    return {
      requestId,
      amountOut: opts.amountOut,
      amountIn: outcome.amountIn,
      refunded: outcome.event.outputKind !== OutputKind.executed,
      settled: false,
    };
  }
  const { amountIn, refunded } = await settleSwap(context, outcome);
  return { requestId, amountOut: opts.amountOut, amountIn, refunded, settled: true };
}
