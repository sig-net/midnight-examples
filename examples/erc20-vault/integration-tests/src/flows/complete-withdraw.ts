// `completeWithdraw`: the settle call of the withdraw flow. It resolves the
// MPC's attested outcome and routes it to the right settle circuit: an
// EXECUTED transfer (1-byte result) settles through `completeWithdraw`,
// which finalizes on success (permissionless cleanup) or refunds the
// WITHDRAWER on a false return, while a NEVER-EXECUTED transfer (reverted or
// replaced, attested as the fixed 5-byte MPC failure output) refunds through
// `refund`. Both refund paths demand proof of the identity
// commitment pinned at withdraw time.

import {
  requestIdBytes,
  type RequestIdHex,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { fetchAttestedRespondOutcome } from "./respond-output.ts";

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The request id being settled. */
  readonly requestId: RequestIdHex;
}

/**
 * Settle a withdraw request through the vault's settle circuits.
 *
 * Resolves the MPC's attestation for `options.requestId` from the signet
 * contract's unauthenticated log by verifying its signature over the
 * independently recomputed transfer output (see
 * {@link fetchAttestedRespondOutcome}), then calls the circuit the outcome's
 * width selects, passing the event AND the recomputed output bytes:
 *
 * - an executed transfer's 1-byte result goes to `completeWithdraw`, which
 *   re-verifies in-circuit, consumes the pending withdrawal, and branches on
 *   the byte: success finalizes (the surrendered value stays burned, any
 *   caller may settle), a false return re-mints to this wallet, which must
 *   be the withdrawer's.
 * - the fixed 5-byte MPC failure output (reverted or replaced transaction)
 *   goes to `refund`, which re-verifies in-circuit, checks the
 *   sentinel bytes, and re-mints to this wallet, again withdrawer-only.
 *
 * Refunds mint under a fresh RANDOM nonce, so the refunded coin cannot be
 * linked to the request. The coin handling is midnight-js's job: the callTx
 * balances the resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param options - The settle arguments.
 * @throws {Error} If no matching attestation has been posted for `options.requestId`
 *   yet, or the withdrawal was already settled (no pending marker on the
 *   ledger).
 */
export async function completeWithdraw(
  context: VaultContext,
  options: CompleteWithdrawOptions,
): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`signet contract: ${context.signetContractAddress}`);
  console.log(`request id:      ${options.requestId}`);

  const outcome = await fetchAttestedRespondOutcome(context, options.requestId);
  if (outcome === undefined) {
    throw new Error(
      `no matching respond-bidirectional attestation posted for request ${options.requestId}: ` +
        `run pollRespondBidirectional first (has the MPC responded to the transfer?)`,
    );
  }

  // A fresh random mint nonce per settle: on the refund paths the circuit
  // threads it into the shielded re-mint verbatim, so randomness HERE is what
  // keeps the refunded coin unlinkable to the (public) request id. The
  // success branch mints nothing and ignores it.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  if (outcome.matchedFailureOutput) {
    console.log("EVM transfer never executed: refunding to this wallet (the withdrawer)");
    const result = await context.vault.callTx.refund(
      requestIdBytes(options.requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${result.public.txId}`);
    return;
  }

  console.log(
    outcome.succeeded
      ? "EVM transfer succeeded: settling final"
      : "EVM transfer returned false: settling with a refund to this wallet (the withdrawer)",
  );
  const result = await context.vault.callTx.completeWithdraw(
    requestIdBytes(options.requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}
