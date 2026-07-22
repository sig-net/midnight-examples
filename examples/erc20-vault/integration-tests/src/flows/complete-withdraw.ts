// `completeWithdraw`: the settle call of the withdraw flow. It settles
// BOTH branches: on EVM success the withdrawal is final and the settle is
// permissionless (cleanup only), while on failure the surrendered value is
// re-minted to the WITHDRAWER, who must be the caller (the circuit demands
// proof of the identity commitment pinned at withdraw time).

import {
  executionSucceeded,
  requestIdBytes,
  type RequestIdHex,
} from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { fetchVerifiedRespondBidirectionalEvent } from "./poll-respond-bidirectional.ts";

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The request id being settled. */
  readonly requestId: RequestIdHex;
}

/**
 * Call the vault's `completeWithdraw` circuit for a completed withdraw
 * request.
 *
 * Fetches the MPC's RespondBidirectionalEvent (`serializedOutput` + ECDSA
 * signature scalars) for `options.requestId` from the signet contract's
 * unauthenticated log, verified off-chain against the vault's stored MPC
 * response key (see {@link fetchVerifiedRespondBidirectionalEvent}), then
 * calls the circuit, which re-verifies the ECDSA signature in-circuit,
 * consumes the pending withdrawal, and branches on the EVM result: success
 * finalizes the withdrawal (the surrendered value stays burned, any caller
 * may settle), while failure re-mints it to this wallet, which must be the
 * withdrawer's (the circuit checks the caller's secret against the
 * commitment pinned at request time). The refund mints under a fresh RANDOM
 * nonce, so the refunded coin cannot be linked to the request. The refund's
 * coin handling is midnight-js's job: `vault.callTx.completeWithdraw(...)`
 * balances the resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param options - The settle arguments.
 * @throws If no verifying response has been posted for `options.requestId`
 *   yet, or the withdrawal was already settled (no pending marker on the
 *   ledger).
 */
export async function completeWithdraw(context: VaultContext, options: CompleteWithdrawOptions): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`signet contract: ${context.signetContractAddress}`);
  console.log(`request id:      ${options.requestId}`);

  const respondBidirectionalEvent = await fetchVerifiedRespondBidirectionalEvent(context, options.requestId);
  if (respondBidirectionalEvent === undefined) {
    throw new Error(
      `no verified respond-bidirectional response posted for request ${options.requestId}: ` +
        `run pollRespondBidirectional first (has the MPC responded to the transfer?)`,
    );
  }

  const outcome = executionSucceeded(respondBidirectionalEvent.serializedOutput)
    ? "EVM transfer succeeded: settling final"
    : "EVM transfer failed: settling with a refund to this wallet (the withdrawer)";
  console.log(outcome);

  // A fresh random mint nonce per settle: on the refund branch the circuit
  // threads it into the shielded re-mint verbatim, so randomness HERE is what
  // keeps the refunded coin unlinkable to the (public) request id. The
  // success branch mints nothing and ignores it.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeWithdraw(
    requestIdBytes(options.requestId),
    respondBidirectionalEvent,
    mintNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}
