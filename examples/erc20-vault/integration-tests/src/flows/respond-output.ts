// Respond-output recomputation: the client half of the hash-only attestation
// protocol. The MPC's RespondBidirectionalEvent carries only the 32-byte
// attestation digest (keccak256 of requestId ++ serializedOutput) plus the
// ECDSA scalars, never the output itself, so the client recomputes the
// output bytes independently and matches them against the attested digest.
// The recomputation mirrors the responder's own extraction exactly
// (fakenet-signer EthereumMonitor / ChainSignatureServer):
//
//   executed tx  -> re-simulate the mined call against the previous block's
//                   state, decode per the schema, re-pack per the schema.
//   reverted or  -> the protocol's fixed 5-byte failure output
//   replaced tx     (MPC_FAILURE_OUTPUT), schema-independent by design.
//
// Digest equality then selects WHICH candidate the MPC attested, which is
// also what routes settlement (claim / completeWithdraw / refundWithdraw).
// The matched bytes go into the settle circuit as an argument, where
// `verifyRespondBidirectionalEvent<N>` re-hashes them and verifies the ECDSA
// signature in-circuit: that in-circuit check is the authentication gate, so
// a forged post that happens to carry a matching digest merely wastes a
// proof, it cannot mint.

import { JsonRpcProvider } from "ethers";

import {
  MPC_FAILURE_OUTPUT,
  calculateSignetAttestationDigest,
  deserializeEvmOutput,
  executionSucceeded,
  isExecutionError,
  requestIdBytes,
  serializeRespondOutput,
  signBidirectionalEventToSignedEVMTransaction,
  type RespondBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

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

/** Options identifying whose signed transaction to recompute from. */
export interface RespondOutcomeOptions {
  /** The request id to resolve. */
  readonly requestId: RequestIdHex;
  /**
   * EVM address the MPC's transaction signature must recover to — the
   * request's derived sender (`context.evmUserAddress` for deposits,
   * `context.evmVaultAddress` for withdrawals). Needed to reconstruct the
   * signed transaction the outcome is recomputed from.
   */
  readonly expectedSigner: string;
}

/**
 * Recompute the candidate serialized outputs the MPC could have attested for
 * `options.requestId`, from the signed transaction's on-chain fate.
 *
 * An executed transaction yields the re-simulated, schema-packed call result
 * (with the fixed failure output alongside, in case the responder observed a
 * later replacement this client has not). A reverted or replaced transaction
 * yields the fixed failure output alone.
 *
 * @param context - The flow context.
 * @param options - The request and its expected transaction signer.
 * @returns The candidate outputs, or `undefined` while the transaction's
 *   fate is not yet decidable (no signature response, or not mined and not
 *   replaced) — the caller should retry later.
 */
export async function recomputeRespondCandidates(
  context: VaultContext,
  options: RespondOutcomeOptions,
): Promise<readonly Uint8Array[] | undefined> {
  const reader = createResponseReader(context);
  const { verified } = await reader.getVerifiedSignatureRespondedEvent(
    options.requestId,
    options.expectedSigner,
  );
  if (verified === undefined) {
    return undefined;
  }
  const request = await reader.getSignatureRequest(options.requestId);
  const transaction = signBidirectionalEventToSignedEVMTransaction(request, verified);
  const { hash, from, to, data, nonce } = transaction;
  if (hash === null || from === null) {
    throw new Error("reconstructed transaction is missing a signature (cannot derive hash/sender)");
  }

  const provider = new JsonRpcProvider(context.evmRpcUrl);
  try {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt === null) {
      // Not mined. A consumed nonce means a different transaction took the
      // slot and this one can never land: the responder attests that as a
      // failure. Otherwise the fate is still open.
      const latestNonce = await provider.getTransactionCount(from, "latest");
      return latestNonce > nonce ? [MPC_FAILURE_OUTPUT] : undefined;
    }
    if (receipt.status === 0) {
      return [MPC_FAILURE_OUTPUT];
    }

    // Executed: mirror the responder's extraction EXACTLY — re-simulate the
    // mined call from the derived sender against the previous block's state,
    // decode per the schema, re-pack per the schema.
    const callResult = await provider.call({
      to,
      data,
      from,
      blockTag: receipt.blockNumber - 1,
    });
    const decoded = deserializeEvmOutput(ERC20_TRANSFER_RESULT_SCHEMA, callResult);
    const executedOutput = serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, decoded);
    return [executedOutput, MPC_FAILURE_OUTPUT];
  } finally {
    provider.destroy();
  }
}

/**
 * Resolve the attested outcome for `requestId`: fetch the posted
 * RespondBidirectionalEvents, recompute the candidate outputs, and return
 * the first event whose attested digest equals a candidate's digest.
 *
 * The respond log is unauthenticated (anyone may post), so digest matching
 * is what selects a trustworthy record here — and the settle circuits
 * re-verify digest AND signature in-circuit, which remains the actual
 * authentication gate.
 *
 * @param context - The flow context.
 * @param requestId - The request id to resolve.
 * @param expectedSigner - The request's derived transaction sender (see
 *   {@link RespondOutcomeOptions.expectedSigner}).
 * @returns The matched outcome, or `undefined` when nothing attested
 *   matches yet.
 */
export async function fetchAttestedRespondOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
  expectedSigner: string,
): Promise<RespondOutcome | undefined> {
  const reader = createResponseReader(context);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) {
    return undefined;
  }
  const candidates = await recomputeRespondCandidates(context, { requestId, expectedSigner });
  if (candidates === undefined) {
    return undefined;
  }
  for (const serializedOutput of candidates) {
    const digest = calculateSignetAttestationDigest(requestIdBytes(requestId), serializedOutput);
    const event = events.find((posted) =>
      Buffer.from(posted.attestationDigest).equals(Buffer.from(digest)),
    );
    if (event !== undefined) {
      return {
        event,
        serializedOutput,
        succeeded: executionSucceeded(serializedOutput),
        isMpcErrorSentinel: isExecutionError(serializedOutput),
      };
    }
  }
  return undefined;
}
