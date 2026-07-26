// Respond-output recomputation: the client half of the hash-only attestation
// protocol. The MPC's RespondBidirectionalEvent carries only the 32-byte
// attestation digest (keccak256 of requestId ++ serializedOutput) plus the
// ECDSA signature, never the output itself, so the client obtains the output
// bytes independently and matches them against the attested digest. The raw
// EVM output comes from the fakenet's public /responses/{requestId} helper
// API (the fakenet traces the mined call with debug_traceTransaction, the
// same RPC method the real MPC uses, and caches the top frame's return
// data), then this side re-packs it per the schema:
//
//   executed tx  -> fetch the raw traced output, decode per the schema,
//                   re-pack per the schema.
//   reverted or  -> the protocol's fixed 5-byte failure output
//   replaced tx     (MPC_FAILURE_OUTPUT), schema-independent by design.
//
// Digest equality then selects WHICH candidate the MPC attested, which is
// also what routes settlement (claim / completeWithdraw / refundWithdraw).
// The fetched output is UNTRUSTED until that match: the matched bytes go
// into the settle circuit as an argument, where
// `verifyRespondBidirectionalEvent<N>` re-hashes them and verifies the ECDSA
// signature in-circuit. That in-circuit check is the authentication gate, so
// a forged post (or a tampered API response) that happens to carry a
// matching digest merely wastes a proof, it cannot mint.

import {
  MPC_FAILURE_OUTPUT,
  calculateSignetAttestationDigest,
  deserializeEvmOutput,
  executionSucceeded,
  isExecutionError,
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
  /** Whether the output reports remote-execution success (first byte 1). */
  readonly succeeded: boolean;
  /** Whether the output is the MPC's fixed failure output (0xdeadbeef...). */
  readonly isMpcErrorSentinel: boolean;
}

/**
 * Resolve the attested outcome for `requestId`: fetch the posted
 * RespondBidirectionalEvents, recompute the serialized output from the
 * fakenet's cached raw EVM output, and return the first event whose attested
 * digest equals the recomputation's digest.
 *
 * An executed transaction's raw output is fetched from the fakenet's
 * /responses API, decoded per the schema and re-packed per the schema (the
 * exact two conversions the responder ran on its side). A reverted or
 * replaced transaction has no output, so the candidate is the protocol's
 * fixed 5-byte failure output. The respond log is unauthenticated (anyone
 * may post), so digest matching is what selects a trustworthy record here,
 * and the settle circuits re-verify digest AND signature in-circuit, which
 * remains the actual authentication gate.
 *
 * @param context - The flow context.
 * @param requestId - The request id to resolve.
 * @returns The matched outcome, or `undefined` when no attestation has been
 *   posted yet or none matches the recomputed digest.
 * @throws Error when an attestation is posted but the fakenet's /responses
 *   API stays unreachable or has no cached entry for the request.
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
  // result (it caches before posting): fetch it now. UNTRUSTED until the
  // digest match below.
  const cached = await fetchFakenetResponse(requestId);
  let serializedOutput: Uint8Array;
  if (cached.success && cached.output !== null) {
    const decoded = deserializeEvmOutput(ERC20_TRANSFER_RESULT_SCHEMA, cached.output);
    serializedOutput = serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, decoded);
  } else {
    serializedOutput = MPC_FAILURE_OUTPUT;
  }

  const digest = calculateSignetAttestationDigest(requestIdBytes(requestId), serializedOutput);
  const event = events.find((posted) =>
    Buffer.from(posted.attestationDigest).equals(Buffer.from(digest)),
  );
  if (event === undefined) {
    return undefined;
  }
  return {
    event,
    serializedOutput,
    succeeded: executionSucceeded(serializedOutput),
    isMpcErrorSentinel: isExecutionError(serializedOutput),
  };
}
