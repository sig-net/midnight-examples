// Respond-output recomputation: the client half of the hash-only attestation
// protocol. The MPC's RespondBidirectionalEvent carries only the 32-byte
// attestation digest (keccak256 of requestId ++ serializedOutput) plus the
// ECDSA signature, never the output itself, so the client obtains the output
// bytes independently and matches them against the attested digest. Every
// call recomputes BOTH candidate outputs the protocol allows and matches the
// posted events against both digests:
//
//   success candidate -> the fakenet's cached raw traced output (from its
//                        public /responses/{requestId} helper API), decoded
//                        per the schema and re-packed per the schema. Only
//                        computable when the cache reports an executed
//                        transaction with output bytes.
//   failure candidate -> the protocol's fixed 5-byte failure output
//                        (MPC_FAILURE_OUTPUT), schema-independent by design,
//                        always a candidate.
//
// Candidate selection is by DIGEST EQUALITY alone: the cache's own success
// flag is unauthenticated and never decides anything, it only gates whether
// a success candidate can be built at all. Which candidate matched is also
// what routes settlement (claim / completeWithdraw / refundWithdraw). The
// fetched output is UNTRUSTED until that match: the matched bytes go into
// the settle circuit as an argument, where
// `verifyRespondBidirectionalEvent<N>` re-hashes them and verifies the ECDSA
// signature in-circuit. That in-circuit check is the authentication gate, so
// a forged post (or a tampered API response) that happens to carry a
// matching digest merely wastes a proof, it cannot mint.

import {
  MPC_FAILURE_OUTPUT,
  calculateSignetAttestationDigest,
  deserializeEvmOutput,
  requestIdBytes,
  serializeRespondOutput,
  type RespondBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { ERC20_TRANSFER_RESULT_SCHEMA } from "../mpc-routing.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/** What the MPC attested for a request, resolved by digest matching. */
export interface RespondOutcome {
  /** The attested event whose digest matched a recomputed candidate. */
  readonly event: RespondBidirectionalEvent;
  /** The recomputed output bytes the digest matched (a circuit argument). */
  readonly serializedOutput: Uint8Array;
  /**
   * True only when the SUCCESS candidate matched AND its decoded transfer
   * result bool is true. The vault's ERC20 transfer schema decodes a single
   * bool, so `succeeded: false` alongside `matchedFailureOutput: false`
   * means the transfer executed and returned false.
   */
  readonly succeeded: boolean;
  /**
   * True when the matched candidate is the protocol's fixed failure output
   * (MPC_FAILURE_OUTPUT), by candidate identity: the transaction reverted or
   * was replaced, so the transfer never executed.
   */
  readonly matchedFailureOutput: boolean;
}

// How long one poll tick waits on the fakenet's /responses API. Deliberately
// short: the OUTER poll loop (pollRespondBidirectional's timeoutMs and
// intervalMs) owns the deadline, so a tick that cannot fetch gives up fast
// and lets the next tick retry.
const FAKENET_FETCH_TICK_TIMEOUT_MS = 3_000;

// One warning per distinct condition per request, so a poll loop retrying
// every second does not repeat the same message every tick.
const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  console.warn(message);
}

/**
 * Resolve the attested outcome for `requestId`: fetch the posted
 * RespondBidirectionalEvents, recompute both candidate serialized outputs,
 * and return the first event whose attested digest equals one of the
 * candidates' digests.
 *
 * The failure candidate (the protocol's fixed 5-byte failure output) is
 * always computed. The success candidate (the fakenet's cached raw output,
 * decoded per the schema and re-packed per the schema, the exact two
 * conversions the responder ran on its side) is attempted only when the
 * cache reports an executed transaction with output bytes, and a decode
 * failure (for example empty `0x` return data from a non-bool ERC20) drops
 * it with a warning rather than crashing the poll. The respond log is
 * unauthenticated (anyone may post), so digest matching is what selects a
 * trustworthy record here, and the settle circuits re-verify digest AND
 * signature in-circuit, which remains the actual authentication gate.
 *
 * A fakenet fetch failure inside one call logs once and yields `undefined`,
 * so the caller's poll loop (its own timeoutMs/intervalMs) owns the
 * deadline: this function never blocks a tick beyond a short fetch timeout.
 *
 * @param context - The flow context.
 * @param requestId - The request id to resolve.
 * @returns The matched outcome, or `undefined` when no attestation has been
 *   posted yet, none matches a recomputed digest, or the fakenet's
 *   /responses API could not serve this tick.
 */
export async function fetchAttestedRespondOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<RespondOutcome | undefined> {
  const reader = createResponseReader(context);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) {
    return undefined;
  }

  // An attestation is posted, so the fakenet has already cached the observed
  // result (it caches before posting): fetch it now, with a short per-tick
  // timeout. UNTRUSTED until the digest match below.
  let cached;
  try {
    cached = await fetchFakenetResponse(requestId, FAKENET_FETCH_TICK_TIMEOUT_MS);
  } catch (error) {
    warnOnce(
      `fetch:${requestId}`,
      `fakenet /responses fetch failed for ${requestId}, will retry on the next poll tick: ${String(error)}`,
    );
    return undefined;
  }

  // The failure candidate always exists. The success candidate needs cached
  // output bytes, and its decode/re-pack may fail (for example empty `0x`
  // return data from an ERC20 that returns nothing): then only the failure
  // candidate can match. The success candidate is tried first (a genuine MPC
  // attests exactly one digest, so order only matters against forged posts).
  const candidates: { serializedOutput: Uint8Array; isFailureOutput: boolean }[] = [];
  let decodedSuccessValue: boolean | undefined;
  if (cached.success && cached.output !== null) {
    try {
      const decoded = deserializeEvmOutput(ERC20_TRANSFER_RESULT_SCHEMA, cached.output);
      decodedSuccessValue = decoded.success === true;
      candidates.push({
        serializedOutput: serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, decoded),
        isFailureOutput: false,
      });
    } catch (error) {
      warnOnce(
        `decode:${requestId}`,
        `could not decode/re-pack the cached output for ${requestId} ` +
          `(matching against the failure candidate only): ${String(error)}`,
      );
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, isFailureOutput: true });

  for (const candidate of candidates) {
    const digest = calculateSignetAttestationDigest(
      requestIdBytes(requestId),
      candidate.serializedOutput,
    );
    const event = events.find((posted) =>
      Buffer.from(posted.attestationDigest).equals(Buffer.from(digest)),
    );
    if (event !== undefined) {
      return {
        event,
        serializedOutput: candidate.serializedOutput,
        succeeded: !candidate.isFailureOutput && decodedSuccessValue === true,
        matchedFailureOutput: candidate.isFailureOutput,
      };
    }
  }
  return undefined;
}
