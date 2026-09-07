// Settle side of the withdraw flow: route the MPC's attested outcome to the
// circuit its width selects. An EXECUTED transfer (1-byte result) settles
// through `completeWithdraw`, which finalizes on success (permissionless
// cleanup) or refunds the WITHDRAWER on a false return, while a NEVER-EXECUTED
// transfer (reverted or replaced, attested as the fixed 5-byte MPC failure
// output) settles through `refundWithdraw`. Both refund paths demand proof of
// the identity commitment pinned at withdraw time.

import {
  requestIdBytes,
  type RequestIdHex,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved withdraw outcome through the circuit its width selects,
 * passing the attested event AND the recomputed output bytes:
 *
 * - an executed transfer's 1-byte result goes to `completeWithdraw`, which
 *   re-verifies in-circuit, consumes the pending withdrawal, and branches on
 *   the byte: success finalizes (the surrendered value stays burned, any
 *   caller may settle), a false return re-mints to this wallet, which must
 *   be the withdrawer's.
 * - the fixed 5-byte MPC failure output (reverted or replaced transaction)
 *   goes to `refundWithdraw`, which re-verifies in-circuit, checks the
 *   sentinel bytes, and re-mints to this wallet, again withdrawer-only.
 *
 * Refunds mint under a fresh RANDOM nonce, so the refunded coin cannot be
 * linked to the request. The coin handling is midnight-js's job: the callTx
 * balances the resulting offer like any other call.
 *
 * Both circuits take `commitmentNonce`: the withdraw's settle-view commitment
 * is the phase-1 request key `requestCommitment(secret, coinNonce)`, so the
 * only way to prove withdrawer-hood on a refund route is to re-present the
 * surrendered coin's nonce. `startWithdraw` returns it for exactly this.
 *
 * @param context - The flow context.
 * @param requestId - The withdraw request id being settled.
 * @param outcome - The attested outcome from
 *   {@link file://./poll-respond-bidirectional.ts pollRespondBidirectional}.
 * @param commitmentNonce - The surrendered coin's nonce, from
 *   {@link file://./start-withdraw.ts startWithdraw}.
 * @throws {Error} If the withdrawal was already settled (no pending marker on
 *   the ledger), or this wallet is not the withdrawer on a refund route.
 */
export async function settleWithdraw(
  context: VaultContext,
  requestId: RequestIdHex,
  outcome: RespondOutcome,
  commitmentNonce: Uint8Array,
): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestId}`);

  // A fresh random mint nonce per settle: on the refund paths the circuit
  // threads it into the shielded re-mint verbatim, so randomness HERE is what
  // keeps the refunded coin unlinkable to the (public) request id. The
  // success branch mints nothing and ignores it.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  if (outcome.matchedFailureOutput) {
    console.log("EVM transfer never executed: refunding to this wallet (the withdrawer)");
    const result = await context.vault.callTx.refundWithdraw(
      requestIdBytes(requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
      commitmentNonce,
    );
    console.log(`refundWithdraw settled in tx ${result.public.txId}`);
    return;
  }

  console.log(
    outcome.succeeded
      ? "EVM transfer succeeded: settling final"
      : "EVM transfer returned false: settling with a refund to this wallet (the withdrawer)",
  );
  const result = await context.vault.callTx.completeWithdraw(
    requestIdBytes(requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
    commitmentNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The withdraw request id to settle. */
  readonly requestId: RequestIdHex;
  /**
   * The surrendered coin's nonce the request was keyed on, from
   * {@link file://./start-withdraw.ts startWithdraw}. Proves withdrawer-hood
   * on the refund routes.
   */
  readonly commitmentNonce: Uint8Array;
}

const MINUTE = 60_000;

/**
 * Poll until the withdrawal's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the shared request map followed by
 * {@link settleWithdraw}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle and the coin nonce it was keyed on.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline, plus whatever {@link settleWithdraw} throws.
 */
export async function completeWithdraw(
  context: VaultContext,
  options: CompleteWithdrawOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: 6 * MINUTE,
  });
  await settleWithdraw(context, options.requestId, outcome, options.commitmentNonce);
}
