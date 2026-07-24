// `pollRespondBidirectional`: stage 2 of the MPC round trip. Poll the Signet
// singleton's respond-bidirectional log by request id until an MPC
// attestation appears whose digest MATCHES an independently recomputed
// serialized output for the request, and return the resolved outcome. There
// is deliberately no push/websocket alternative.

import { sleepUnlessAborted, type RequestIdHex } from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { fetchAttestedRespondOutcome, type RespondOutcome } from "./respond-output.ts";

export { fetchAttestedRespondOutcome, type RespondOutcome } from "./respond-output.ts";

/** Options for {@link pollRespondBidirectional}. */
export interface PollRespondBidirectionalOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * EVM address the MPC's transaction signature must recover to — the
   * request's derived sender. Deposit requests are signed by the user's
   * derived account (`context.evmUserAddress`); withdraw requests by the
   * VAULT's (`context.evmVaultAddress`). Always explicit: this flow is
   * generic over request kinds, and which account signs is the caller's
   * knowledge. The outcome recomputation reconstructs that account's signed
   * transaction and follows its on-chain fate.
   */
  readonly expectedSigner: string;
}

/**
 * Poll the signet contract until an MPC respond-bidirectional attestation
 * for `options.requestId` MATCHES the independently recomputed output, and
 * return the resolved outcome.
 *
 * The event carries only the attestation digest, so each tick recomputes
 * the candidate outputs from the signed transaction's on-chain fate and
 * digest-matches them against the posted events (see
 * `fetchAttestedRespondOutcome`): the log is unauthenticated, and digest
 * matching is what makes a returned record meaningful off-chain. The settle
 * circuits re-verify digest and ECDSA signature in-circuit, which is the
 * actual authentication gate. This flow owns the poll loop, the timeout,
 * and the reporting: it logs the outcome (success flag / MPC failure
 * output); acting on it (claiming, refunding) is the caller's job.
 *
 * @param context - The flow context.
 * @param options - What to poll for and how patiently.
 * @returns The resolved outcome (attested event + matched output bytes).
 * @throws Error when the contract has no state on-chain or `timeoutMs`
 *   elapses with no matching attestation posted.
 */
export async function pollRespondBidirectional(
  context: VaultContext,
  options: PollRespondBidirectionalOptions,
): Promise<RespondOutcome> {
  console.log(`signet contract:   ${context.signetContractAddress}`);
  console.log(`request id:        ${options.requestId}`);
  console.log(`expected signer:   ${options.expectedSigner}`);
  console.log(`poll:              every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  // The reads are single-shot; this loop owns the cadence and the give-up
  // timeout.
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const outcome = await fetchAttestedRespondOutcome(
        context,
        options.requestId,
        options.expectedSigner,
      );
      if (outcome !== undefined) {
        if (outcome.isMpcErrorSentinel) {
          console.log("remote execution FAILED (MPC failure output attested)");
        } else {
          console.log(`remote execution ${outcome.succeeded ? "succeeded" : "returned false"}`);
        }
        return outcome;
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a matching respond-bidirectional attestation to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
