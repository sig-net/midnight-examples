// Settle side of the redeem flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit the output selects (completeRedeem mints the
// attested USDC assets, refundRedeem re-mints the surrendered shares).
import { VAULT_REDEEM_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
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

import { REDEEM_OUTPUT_SCHEMA, REDEEM_RESPOND_SCHEMA } from "../evm-stata.ts";
import { type FakenetResponse, fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import { warnOnce } from "../warn-once.ts";

/** The resolved attested outcome of a redeem (uint64 assets minted, or the failure output). */
export interface RedeemOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
  readonly matchedFailureOutput: boolean;
}

/** One output a posted attestation may commit to, and the assets settling on it yields. */
interface RedeemCandidate {
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
  readonly isFailureOutput: boolean;
}

// How long one candidate build waits on the fakenet's /responses API. Short on purpose: the
// poll loop owns the deadline, so a tick that cannot fetch gives up fast and the next retries.
const FAKENET_FETCH_TICK_TIMEOUT_MS = 3_000;

/**
 * Recompute both candidate outputs the protocol allows for a redeem (the redeem-schema twin of
 * complete-supply.ts's candidate build): the success candidate is the fakenet's cached traced
 * output decoded per the uint256 output schema and re-packed per the uint64 respond schema, the
 * failure candidate is the protocol's fixed 5-byte output. A decode failure drops the success
 * candidate with a warning. The fakenet serves one fixed observation per request, so a caller
 * resolving this once holds the candidates for its whole poll.
 *
 * @param requestId - The redeem request id whose execution result to recompute.
 * @returns The candidates, failure last, or undefined when the fakenet cannot serve this tick.
 */
async function fetchRedeemCandidates(
  requestId: RequestIdHex,
): Promise<RedeemCandidate[] | undefined> {
  let cached: FakenetResponse;
  try {
    cached = await fetchFakenetResponse(requestId, FAKENET_FETCH_TICK_TIMEOUT_MS);
  } catch (error) {
    warnOnce(
      `redeem-fetch:${requestId}`,
      `fakenet /responses fetch failed for redeem ${requestId}, will retry on the next poll tick: ${String(error)}`,
    );
    return undefined;
  }

  const candidates: RedeemCandidate[] = [];
  if (cached.success && cached.output !== null) {
    try {
      const decoded = deserializeEvmOutput(REDEEM_OUTPUT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(REDEEM_RESPOND_SCHEMA, decoded),
        assets: (decoded as { assets: bigint }).assets,
        isFailureOutput: false,
      });
    } catch (error) {
      warnOnce(
        `redeem-decode:${requestId}`,
        `could not decode/re-pack the cached output for redeem ${requestId} ` +
          `(matching against the failure candidate only): ${String(error)}`,
      );
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, assets: 0n, isFailureOutput: true });
  return candidates;
}

/**
 * Select the outcome of the first posted event whose ECDSA signature verifies over one of
 * `candidates`. The signature-only event carries no digest, so this signature check against the
 * vault-pinned response key is the whole of candidate selection.
 *
 * @param events - The posts declared under `requestId`, unverified as the event log allows.
 * @param requestId - The redeem request id the attestation must commit to.
 * @param candidates - The recomputed outputs to try, in preference order.
 * @param mpcResponseKey - The response key the vault pinned at initialise.
 * @returns The matching outcome, or undefined when no post attests any candidate.
 */
function matchRedeemOutcome(
  events: readonly RespondBidirectionalEvent[],
  requestId: RequestIdHex,
  candidates: readonly RedeemCandidate[],
  mpcResponseKey: Secp256k1Point,
): RedeemOutcome | undefined {
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
        assets: candidate.assets,
        matchedFailureOutput: candidate.isFailureOutput,
      };
    }
  }
  return undefined;
}

/** Options for {@link pollRedeemOutcome}. */
export interface PollRedeemOutcomeOptions {
  /** The redeem request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; 6 minutes when omitted. */
  readonly timeoutMs?: number;
}

const MINUTE = 60_000;

/**
 * Poll until the MPC posts a signature-verified attestation for the redeem
 * (see {@link matchRedeemOutcome} for candidate selection).
 *
 * Everything a tick would otherwise redo is resolved once: the reader, whose request-record
 * cache a rebuild would throw away, the response key the vault pinned at initialise, and the
 * candidates {@link fetchRedeemCandidates} builds from the fakenet's fixed observation. A tick
 * costs one event read plus a signature check per candidate.
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested assets minted, or the failure output).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollRedeemOutcome(
  context: VaultContext,
  options: PollRedeemOutcomeOptions,
): Promise<RedeemOutcome> {
  const reader = createResponseReader(context, VAULT_REDEEM_REQUESTS_PATH);
  // The key the settle circuit verifies against, read from the vault's own ledger: checking
  // off-chain against anything else risks accepting a post that cannot prove. initialise
  // writes it once and nothing rewrites it, so one read serves every tick.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const end = Date.now() + (options.timeoutMs ?? 6 * MINUTE);
  let candidates: RedeemCandidate[] | undefined;
  while (Date.now() < end) {
    const events = await reader.getRespondBidirectionalEvents(options.requestId);
    // A posted attestation means the fakenet has already cached the observed result (it caches
    // before it posts), so the candidates are worth building only once a post appears.
    if (events.length > 0) {
      candidates ??= await fetchRedeemCandidates(options.requestId);
      if (candidates !== undefined) {
        const outcome = matchRedeemOutcome(events, options.requestId, candidates, mpcResponseKey);
        if (outcome !== undefined) return outcome;
      }
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  throw new Error(`timed out waiting for a redeem attestation for ${options.requestId}`);
}

/**
 * Settle a resolved redeem outcome through the circuit its content selects:
 * `completeRedeem` for attested assets (mints the USDC), `refundRedeem` for
 * the fixed MPC failure output (re-mints the surrendered shares).
 *
 * @param context - The flow context.
 * @param requestId - The redeem request id being settled.
 * @param outcome - The attested outcome from {@link pollRedeemOutcome}.
 * @returns The attested assets minted (0 on refund) and whether the redeem was refunded.
 */
export async function settleRedeem(
  context: VaultContext,
  requestId: RequestIdHex,
  outcome: RedeemOutcome,
): Promise<{ assets: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.matchedFailureOutput) {
    console.log("redeem tx never executed: refunding the shares to this wallet");
    const r = await context.vault.callTx.refundRedeem(
      requestIdBytes(requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { assets: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeRedeem(
    requestIdBytes(requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(
    `completeRedeem settled in tx ${r.public.txId} (minted ${String(outcome.assets)} USDC)`,
  );
  return { assets: outcome.assets, refunded: false };
}

/**
 * Poll until the redeem outcome resolves, then settle: {@link pollRedeemOutcome}
 * followed by {@link settleRedeem}.
 *
 * @param context - The flow context.
 * @param requestId - The redeem request id to settle.
 * @returns The attested assets minted (0 on refund) and whether the redeem was refunded.
 */
export async function completeRedeem(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<{ assets: bigint; refunded: boolean }> {
  const outcome = await pollRedeemOutcome(context, { requestId });
  return settleRedeem(context, requestId, outcome);
}
