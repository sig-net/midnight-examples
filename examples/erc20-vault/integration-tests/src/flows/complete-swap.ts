// Settle side of the swap flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit the output selects (completeSwap mints the
// exact amountOut of tokenOut plus the unspent tokenIn as change, refundSwap re-mints the
// surrendered amountInMaximum).
import { VAULT_SWAP_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import {
  deserializeEvmOutput,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";

import { SWAP_OUTPUT_SCHEMA, SWAP_RESPOND_SCHEMA } from "../evm-swap.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";

const MINUTE = 60_000;

/** The resolved attested outcome of a swap (uint64 amountIn spent, or the failure output). */
export interface SwapOutcome {
  readonly event: Awaited<ReturnType<SignetReader["getRespondBidirectionalEvents"]>>[number];
  readonly serializedOutput: Uint8Array;
  readonly amountIn: bigint;
  readonly matchedFailureOutput: boolean;
}
type SignetReader = ReturnType<typeof createResponseReader>;

/**
 * Resolve the MPC's attested swap outcome by SIGNATURE VERIFICATION (the swap-schema twin of
 * the transfer flow's fetchAttestedRespondOutcome): the success candidate is the fakenet's
 * cached traced output decoded per the uint256 output schema and re-packed per the uint64
 * respond schema (the asymmetric packing the MPC posts); the failure candidate is the
 * protocol's fixed 5-byte output. The signature-only event carries no digest, so a candidate
 * is selected only when a posted event's ECDSA signature verifies over it against the
 * vault-pinned response key. Returns undefined until a matching attestation posts.
 *
 * @param context - The flow context.
 * @param requestId - The swap request id to resolve.
 * @returns The resolved outcome (attested amountIn spent, or the failure output), or undefined.
 */
async function fetchSwapOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<SwapOutcome | undefined> {
  const reader = createResponseReader(context, VAULT_SWAP_REQUESTS_PATH);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;

  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const cached = await fetchFakenetResponse(requestId, 3_000).catch(() => undefined);
  const candidates: { serializedOutput: Uint8Array; amountIn: bigint; isFailureOutput: boolean }[] =
    [];
  if (cached?.success && cached.output != null) {
    try {
      const decoded = deserializeEvmOutput(SWAP_OUTPUT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(SWAP_RESPOND_SCHEMA, decoded),
        amountIn: (decoded as { amountIn: bigint }).amountIn,
        isFailureOutput: false,
      });
    } catch {
      /* only the failure candidate can match */
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, amountIn: 0n, isFailureOutput: true });

  for (const c of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        c.serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    if (event) {
      return {
        event,
        serializedOutput: c.serializedOutput,
        amountIn: c.amountIn,
        matchedFailureOutput: c.isFailureOutput,
      };
    }
  }
  return undefined;
}

/** Options for {@link pollSwapOutcome}. */
export interface PollSwapOutcomeOptions {
  /** The swap request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; 6 minutes when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the swap
 * (see {@link fetchSwapOutcome} for candidate resolution).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested amountIn spent, or the failure output).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollSwapOutcome(
  context: VaultContext,
  options: PollSwapOutcomeOptions,
): Promise<SwapOutcome> {
  const end = Date.now() + (options.timeoutMs ?? 6 * MINUTE);
  let outcome: SwapOutcome | undefined;
  while (
    Date.now() < end &&
    (outcome = await fetchSwapOutcome(context, options.requestId)) === undefined
  ) {
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  if (!outcome)
    throw new Error(`timed out waiting for a swap attestation for ${options.requestId}`);
  return outcome;
}

/**
 * Settle a resolved swap outcome through the circuit its width selects:
 * `completeSwap` for an attested amountIn (mints the exact amountOut of
 * tokenOut plus the unspent tokenIn as change), `refundSwap` for the fixed
 * MPC failure output (re-mints the surrendered amountInMaximum).
 *
 * @param context - The flow context.
 * @param requestId - The swap request id being settled.
 * @param outcome - The attested outcome from {@link pollSwapOutcome}.
 * @returns The attested amountIn spent (0 on refund) and whether the swap was refunded.
 */
export async function settleSwap(
  context: VaultContext,
  requestId: RequestIdHex,
  outcome: SwapOutcome,
): Promise<{ amountIn: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.matchedFailureOutput) {
    console.log("swap tx never executed: refunding tokenIn to this wallet");
    const r = await context.vault.callTx.refundSwap(
      requestIdBytes(requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { amountIn: 0n, refunded: true };
  }
  // completeSwap mints two coins (the swapped output and the unspent change), each under its
  // own random nonce: a derived second nonce would leave the change coin no entropy of its own.
  const changeNonce = crypto.getRandomValues(new Uint8Array(32));
  const r = await context.vault.callTx.completeSwap(
    requestIdBytes(requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
    changeNonce,
  );
  console.log(
    `completeSwap settled in tx ${r.public.txId} (spent ${String(outcome.amountIn)} tokenIn)`,
  );
  return { amountIn: outcome.amountIn, refunded: false };
}

/**
 * Poll until the swap outcome resolves, then settle: {@link pollSwapOutcome}
 * followed by {@link settleSwap}.
 *
 * @param context - The flow context.
 * @param requestId - The swap request id to settle.
 * @returns The attested amountIn spent (0 on refund) and whether the swap was refunded.
 */
export async function completeSwap(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<{ amountIn: bigint; refunded: boolean }> {
  const outcome = await pollSwapOutcome(context, { requestId });
  return settleSwap(context, requestId, outcome);
}
