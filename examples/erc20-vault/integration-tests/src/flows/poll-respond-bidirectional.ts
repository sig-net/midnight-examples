// `pollRespondBidirectional` — stage 2 of the MPC round trip: poll the
// central signet contract's respond-bidirectional index by request id until
// the MPC's Schnorr-signed attestation of a request's remote EVM execution
// appears, and return the record. There is deliberately no push/websocket
// alternative.

import {
  isExecutionError,
  executionSucceeded,
  sleepUnlessAborted,
  type RespondBidirectional,
  type RequestIdHex,
} from "@sig-net/midnight";

import { createResponseReader, type VaultContext } from "../vault-context.ts";

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
 * Poll the signet contract until the MPC's respond-bidirectional attestation
 * for `options.requestId` appears in its respond-bidirectional index, and
 * return it.
 *
 * The read is delegated to signet-midnight's
 * `SignetRequestResponseReader.getRespondBidirectional`: each tick reads the
 * single authenticated slot at `requestId`; `undefined` means not posted
 * yet. No off-chain verification happens here — none is needed: the signet
 * contract verified the attestation IN-CIRCUIT at post time (Schnorr over
 * `(requestId, hash(serializedOutput, outputLen))` against its sealed MPC
 * key), so a stored record is authentic by construction. This flow owns the
 * poll loop, the timeout, and the reporting: it decodes and logs the outcome
 * (success flag / MPC error sentinel); acting on it (claiming, refunding) is
 * the caller's job.
 *
 * @param context - The flow context.
 * @param options - What to poll for and how patiently.
 * @returns The attestation record.
 * @throws Error when the contract has no state on-chain or `timeoutMs`
 *   elapses with no attestation posted.
 */
export async function pollRespondBidirectional(
  context: VaultContext,
  options: PollRespondBidirectionalOptions,
): Promise<RespondBidirectional> {
  console.log(`signet contract:   ${context.signetContractAddress}`);
  console.log(`request id:        ${options.requestId}`);
  console.log(`poll:              every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = createResponseReader(context);

  // The reader is single-shot; this loop owns the cadence and the give-up
  // timeout.
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const respondBidirectional = await reader.getRespondBidirectional(
        options.requestId,
      );
      if (respondBidirectional !== undefined) {
        if (isExecutionError(respondBidirectional.serializedOutput)) {
          console.log("remote execution FAILED (MPC error sentinel)");
        } else {
          console.log(`remote execution ${executionSucceeded(respondBidirectional.serializedOutput) ? "succeeded" : "returned false"}`);
        }
        return respondBidirectional;
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a respond-bidirectional attestation to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
