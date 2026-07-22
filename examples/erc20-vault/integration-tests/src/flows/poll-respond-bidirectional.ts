// `pollRespondBidirectional`: stage 2 of the MPC round trip. Poll the Signet
// singleton's respond-bidirectional log by request id until an MPC
// RespondBidirectionalEvent for the request appears whose ECDSA signature
// VERIFIES against the vault's stored MPC response key, and return the
// record. There is deliberately no push/websocket alternative.

import {
  isExecutionError,
  executionSucceeded,
  pureCircuits as signetCircuits,
  requestIdBytes,
  sleepUnlessAborted,
  type RespondBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";

/** Options for {@link pollRespondBidirectional}. */
export interface PollRespondBidirectionalOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Fetch the first VERIFIED respond-bidirectional response for `requestId`,
 * or `undefined` when none is posted (or none verifies) yet.
 *
 * The Signet singleton's respond-bidirectional log is an unauthenticated
 * append-only log: anyone may post, so every entry is judged here by the
 * SAME check the vault's settle circuits run in-circuit, i.e. the compiled
 * `verifyRespondBidirectionalEvent` over the attestation digest of
 * (requestId, output), against the MPC response key the vault's initialize
 * pinned on its ledger. The first verifying post wins; forged or garbage
 * posts are skipped, never trusted.
 *
 * @param context - The flow context.
 * @param requestId - The request id to fetch a response for.
 * @returns The first verifying response record, or `undefined`.
 */
export async function fetchVerifiedRespondBidirectionalEvent(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<RespondBidirectionalEvent | undefined> {
  const reader = createResponseReader(context);
  const ledgerState = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  return events.find((event) =>
    signetCircuits.verifyRespondBidirectionalEvent(
      requestIdBytes(requestId),
      event,
      ledgerState.mpcResponseKey,
    ),
  );
}

/**
 * Poll the signet contract until a VERIFIED MPC respond-bidirectional
 * response for `options.requestId` appears in its respond-bidirectional log,
 * and return it.
 *
 * Each tick reads the log's posts for the request via signet-midnight's
 * `SignetRequestResponseReader.getRespondBidirectionalEvents` and verifies
 * them with {@link fetchVerifiedRespondBidirectionalEvent}: the log is
 * unauthenticated, so verification against the vault's stored MPC response
 * key is what makes a returned record trustworthy. This flow owns the poll
 * loop, the timeout, and the reporting: it decodes and logs the outcome
 * (success flag / MPC error sentinel); acting on it (claiming, refunding) is
 * the caller's job.
 *
 * @param context - The flow context.
 * @param options - What to poll for and how patiently.
 * @returns The verified response record.
 * @throws Error when the contract has no state on-chain or `timeoutMs`
 *   elapses with no verifying response posted.
 */
export async function pollRespondBidirectional(
  context: VaultContext,
  options: PollRespondBidirectionalOptions,
): Promise<RespondBidirectionalEvent> {
  console.log(`signet contract:   ${context.signetContractAddress}`);
  console.log(`request id:        ${options.requestId}`);
  console.log(`poll:              every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  // The reads are single-shot; this loop owns the cadence and the give-up
  // timeout.
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const respondBidirectionalEvent = await fetchVerifiedRespondBidirectionalEvent(
        context,
        options.requestId,
      );
      if (respondBidirectionalEvent !== undefined) {
        if (isExecutionError(respondBidirectionalEvent.serializedOutput)) {
          console.log("remote execution FAILED (MPC error sentinel)");
        } else {
          console.log(`remote execution ${executionSucceeded(respondBidirectionalEvent.serializedOutput) ? "succeeded" : "returned false"}`);
        }
        return respondBidirectionalEvent;
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a verified respond-bidirectional response to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
