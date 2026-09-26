// `pollRespondBidirectional`: stage 2 of the MPC round trip. Poll the Signet
// singleton's emitted respond-bidirectional events by request id until an MPC
// attestation appears whose signature VERIFIES over the independently
// recomputed serialized output for the request, and return the resolved
// outcome. There is deliberately no push/websocket alternative.
import { OutputKind, type RequestIdHex } from "@sig-net/midnight";

import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import {
  fetchAttestedRespondOutcome,
  type RespondOutcome,
  type RespondOutputSchemas,
  RespondPollMemo,
} from "./respond-output.ts";

export {
  fetchAttestedRespondOutcome,
  type RespondOutcome,
  type RespondOutputSchemas,
} from "./respond-output.ts";

/** Options for {@link pollRespondBidirectional}. */
export interface PollRespondBidirectionalOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * The resolved ledger-tree path of the map holding the request. Deposits
   * pass VAULT_DEPOSIT_REQUESTS_PATH (the depositEventMap); withdrawals take
   * the default VAULT_REQUESTS_PATH (the signBidirectionalEventMap they share
   * with the approves).
   */
  readonly requestsPath?: readonly number[];
}

/**
 * The JSON text of an on-ledger schema field. The contract stores each
 * schema NUL-padded to its declared Compact width (`pad(N, "...")`).
 *
 * @param padded - The schema bytes as the request record carries them.
 * @returns The schema's JSON text, padding removed.
 */
function schemaJson(padded: Uint8Array): string {
  return new TextDecoder().decode(padded).replace(/\0+$/u, "");
}

/**
 * Poll the signet contract until an MPC respond-bidirectional attestation
 * for `options.requestId` VERIFIES over the independently recomputed output,
 * and return the resolved outcome.
 *
 * The serialized output travels off chain, so each tick obtains it from the
 * context's `respondOutputSource` (recomputed from the observed raw EVM
 * output, or downloaded from the MPC's output cache) and checks the posted
 * events' signatures against it (see `fetchAttestedRespondOutcome`): the
 * event log is unauthenticated, and that check is what makes a returned
 * record meaningful off-chain. The settle circuits run the same check
 * in-circuit, which is the actual authentication gate. The schemas the
 * recomputation runs are the request record's own, read once here: they are
 * what the MPC ran, and the reader, the pinned response key and the observed
 * output are likewise resolved once for the whole poll
 * ({@link RespondPollMemo}). This flow owns the poll loop, the timeout, and
 * the reporting: it logs the outcome (the verified output kind and, for an
 * executed transfer, its success flag); acting on it (claiming, refunding)
 * is the caller's job.
 *
 * @param context - The flow context.
 * @param options - What to poll for and how patiently.
 * @returns The resolved outcome (attested event + verified output bytes).
 * @throws {Error} When the contract has no state on-chain or holds no
 *   request under `options.requestId`, or `timeoutMs` elapses with no
 *   verifying attestation posted (an EVM endpoint or cache that stays
 *   unreachable surfaces as this timeout: each tick's failure is logged and
 *   retried, this loop owns the deadline).
 */
export async function pollRespondBidirectional(
  context: VaultContext,
  options: PollRespondBidirectionalOptions,
): Promise<RespondOutcome> {
  console.log(`signet contract:   ${context.signetContractAddress}`);
  console.log(`request id:        ${options.requestId}`);
  console.log(`output source:     ${context.respondOutputSource}`);
  console.log(
    `poll:              every ${String(options.intervalMs)}ms, up to ${String(options.timeoutMs)}ms`,
  );

  const memo = new RespondPollMemo(createResponseReader(context, options.requestsPath));
  const request = await memo.reader.getSignatureRequest(options.requestId);
  const schemas: RespondOutputSchemas = {
    outputDeserializationSchema: schemaJson(request.outputDeserializationSchema),
    respondSerializationSchema: schemaJson(request.respondSerializationSchema),
  };

  // The reads are single-shot; this loop owns the cadence and the give-up
  // timeout.
  const progress = new PollProgress(`attestation ${options.requestId}`, options.timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const outcome = await fetchAttestedRespondOutcome(
        context,
        options.requestId,
        context.respondOutputSource,
        schemas,
        options.requestsPath,
        progress,
        memo,
      );
      if (outcome !== undefined) {
        if (outcome.event.outputKind === OutputKind.executed) {
          console.log(`remote execution ${outcome.succeeded ? "succeeded" : "returned false"}`);
        } else {
          console.log(
            `remote execution ${OutputKind[outcome.event.outputKind]} at block ${String(outcome.event.blockHeight)}: the transaction never executed`,
          );
        }
        return outcome;
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}
