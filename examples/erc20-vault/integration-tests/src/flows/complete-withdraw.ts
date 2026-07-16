// `completeWithdraw` — the settle call of the withdraw flow. It settles
// BOTH branches: on EVM success the withdrawal is final and the settle is
// permissionless (cleanup only); on failure the surrendered value is
// re-minted to the WITHDRAWER, who must be the caller — the circuit demands
// proof of the identity commitment pinned at withdraw time.

import {
  executionSucceeded,
  requestIdBytes,
  type RequestIdHex,
} from "@sig-net/midnight";

import { createResponseReader, type VaultContext } from "../vault-context.ts";

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The request id being settled. */
  readonly requestId: RequestIdHex;
}

/**
 * Call the vault's `completeWithdraw` circuit for a completed withdraw
 * request.
 *
 * Fetches the MPC's respond-bidirectional attestation (`serializedOutput` +
 * Schnorr signature components) for `options.requestId` from the signet
 * contract via the `SignetRequestResponseReader` — the same read the
 * response server writes to — then calls the circuit, which verifies the MPC
 * public key hash and the Schnorr signature, consumes the pending
 * withdrawal, and branches on the EVM result: success finalizes the
 * withdrawal (the surrendered value stays burned, any caller may settle);
 * failure re-mints it to this wallet, which must be the withdrawer's — the
 * circuit checks the caller's secret against the commitment pinned at
 * request time. The refund mints under a fresh RANDOM nonce, so the refunded
 * coin cannot be linked to the request. The refund's coin handling is
 * midnight-js's job: `vault.callTx.completeWithdraw(...)` balances the
 * resulting offer like any other call.
 *
 * The attestation is authentic by construction: the signet contract verified
 * it IN-CIRCUIT at post time, so a stored record needs no off-chain re-check
 * here — an absent one just means the MPC has not attested yet (poll first).
 *
 * @param context - The flow context.
 * @param options - The settle arguments.
 * @throws If no attestation has been posted for `options.requestId` yet, or
 *   the withdrawal was already settled (no pending marker on the ledger).
 */
export async function completeWithdraw(context: VaultContext, options: CompleteWithdrawOptions): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`signet contract: ${context.signetContractAddress}`);
  console.log(`request id:      ${options.requestId}`);

  const reader = createResponseReader(context);

  const respondBidirectional = await reader.getRespondBidirectional(options.requestId);
  if (respondBidirectional === undefined) {
    throw new Error(
      `no respond-bidirectional attestation posted for request ${options.requestId} — ` +
        `run pollRespondBidirectional first (has the MPC attested the transfer?)`,
    );
  }

  const outcome = executionSucceeded(respondBidirectional.serializedOutput)
    ? "EVM transfer succeeded — settling final"
    : "EVM transfer failed — settling with a refund to this wallet (the withdrawer)";
  console.log(outcome);

  // A fresh random mint nonce per settle: on the refund branch the circuit
  // threads it into the shielded re-mint verbatim, so randomness HERE is what
  // keeps the refunded coin unlinkable to the (public) request id. The
  // success branch mints nothing and ignores it.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeWithdraw(
    requestIdBytes(options.requestId),
    respondBidirectional,
    mintNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}
