// Settle side of the swap flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit the output selects (completeSwap mints the
// exact amountOut of tokenOut plus the unspent tokenIn as change, refundSwap re-mints the
// surrendered amountInMaximum).
import {
  deserializeEvmOutput,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  type Secp256k1Point,
  serializeRespondOutput,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { VAULT_SWAP_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { SWAP_OUTPUT_SCHEMA, SWAP_RESPOND_SCHEMA } from "../evm-swap.ts";
import { type FakenetResponse, fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { warnOnce } from "../warn-once.ts";

/** The resolved attested outcome of a swap (uint64 amountIn spent, or the failure output). */
export interface SwapOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly amountIn: bigint;
  readonly matchedFailureOutput: boolean;
}

/** One output a posted attestation may commit to, and the amountIn settling on it yields. */
interface SwapCandidate {
  readonly serializedOutput: Uint8Array;
  readonly amountIn: bigint;
  readonly isFailureOutput: boolean;
}

// How long one candidate build waits on the fakenet's /responses API. Short on purpose: the
// poll loop owns the deadline, so a tick that cannot fetch gives up fast and the next retries.
const FAKENET_FETCH_TICK_TIMEOUT_MS = 3_000;

/**
 * Recompute both candidate outputs the protocol allows for a swap: the success candidate is the
 * fakenet's cached traced output decoded per the uint256 output schema and re-packed per the
 * uint64 respond schema (the asymmetric packing the MPC posts), the failure candidate is the
 * protocol's fixed 5-byte output. A decode failure drops the success candidate with a warning,
 * leaving only the failure candidate able to match. The fakenet serves one fixed observation
 * per request, so a caller resolving this once holds the candidates for its whole poll.
 *
 * @param requestId - The swap request id whose execution result to recompute.
 * @returns The candidates, failure last, or undefined when the fakenet cannot serve this tick.
 */
async function fetchSwapCandidates(requestId: RequestIdHex): Promise<SwapCandidate[] | undefined> {
  let cached: FakenetResponse;
  try {
    cached = await fetchFakenetResponse(requestId, FAKENET_FETCH_TICK_TIMEOUT_MS);
  } catch (error) {
    warnOnce(
      `swap-fetch:${requestId}`,
      `fakenet /responses fetch failed for swap ${requestId}, will retry on the next poll tick: ${String(error)}`,
    );
    return undefined;
  }

  const candidates: SwapCandidate[] = [];
  if (cached.success && cached.output !== null) {
    try {
      const decoded = deserializeEvmOutput(SWAP_OUTPUT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(SWAP_RESPOND_SCHEMA, decoded),
        amountIn: (decoded as { amountIn: bigint }).amountIn,
        isFailureOutput: false,
      });
    } catch (error) {
      warnOnce(
        `swap-decode:${requestId}`,
        `could not decode/re-pack the cached output for swap ${requestId} ` +
          `(matching against the failure candidate only): ${String(error)}`,
      );
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, amountIn: 0n, isFailureOutput: true });
  return candidates;
}

/**
 * Select the outcome of the first posted event whose ECDSA signature verifies over one of
 * `candidates`. The signature-only event carries no digest, so this signature check against the
 * vault-pinned response key is the whole of candidate selection.
 *
 * @param events - The posts declared under `requestId`, unverified as the event log allows.
 * @param requestId - The swap request id the attestation must commit to.
 * @param candidates - The recomputed outputs to try, in preference order.
 * @param mpcResponseKey - The response key the vault pinned at initialise.
 * @returns The matching outcome, or undefined when no post attests any candidate.
 */
function matchSwapOutcome(
  events: readonly RespondBidirectionalEvent[],
  requestId: RequestIdHex,
  candidates: readonly SwapCandidate[],
  mpcResponseKey: Secp256k1Point,
): SwapOutcome | undefined {
  for (const candidate of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        candidate.serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    if (event !== undefined) {
      return {
        event,
        serializedOutput: candidate.serializedOutput,
        amountIn: candidate.amountIn,
        matchedFailureOutput: candidate.isFailureOutput,
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

const MINUTE = 60_000;

/**
 * Poll until the MPC posts a signature-verified attestation for the swap
 * (see {@link matchSwapOutcome} for candidate selection).
 *
 * Everything a tick would otherwise redo is resolved once: the reader, whose request-record
 * cache a rebuild would throw away, the response key the vault pinned at initialise, and the
 * candidates {@link fetchSwapCandidates} builds from the fakenet's fixed observation. A tick
 * costs one event read plus a signature check per candidate.
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
  const reader = createResponseReader(context, VAULT_SWAP_REQUESTS_PATH);
  // The key the settle circuit verifies against, read from the vault's own ledger: checking
  // off-chain against anything else risks accepting a post that cannot prove. initialise
  // writes it once and nothing rewrites it, so one read serves every tick.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const end = Date.now() + (options.timeoutMs ?? 6 * MINUTE);
  let candidates: SwapCandidate[] | undefined;
  while (Date.now() < end) {
    const events = await reader.getRespondBidirectionalEvents(options.requestId);
    // A posted attestation means the fakenet has already cached the observed result (it caches
    // before it posts), so the candidates are worth building only once a post appears.
    if (events.length > 0) {
      candidates ??= await fetchSwapCandidates(options.requestId);
      if (candidates !== undefined) {
        const outcome = matchSwapOutcome(events, options.requestId, candidates, mpcResponseKey);
        if (outcome !== undefined) return outcome;
      }
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  throw new Error(`timed out waiting for a swap attestation for ${options.requestId}`);
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
