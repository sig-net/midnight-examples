// Settle side of the redeem flow: queue the MPC's attestation of the vault's
// stataToken redeem, flush it, then settle through `completeRedeem` with the
// request id, the output bytes the attestation signs, and a fresh RANDOM mint nonce
// so the minted coin cannot be linked back to the request.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  VAULT_REDEEM_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved redeem outcome: {@link queueAndFlushAttestation}, then call
 * `completeRedeem` with the request id, the output bytes (eight zero bytes for
 * a failed or unviable redeem, whose output the circuit ignores) and a random
 * mint nonce. An executed redeem mints the attested assets as the
 * stataUnderlying vault coin. A failed or unviable one re-mints the surrendered
 * stataToken shares. Either mint goes to this wallet, which must be the
 * redeemer's. The mint's coin handling is midnight-js's job: the callTx balances
 * the resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 */
export async function settleRedeem(context: VaultContext, outcome: RespondOutcome): Promise<void> {
  const executed = outcome.event.outputKind === OutputKind.executed;
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    executed
      ? `EVM redeem executed: completeRedeem mints ${String(pureCircuits.redeemAssets(outcome.serializedOutput))} of the underlying to this wallet (the redeemer)`
      : `the MPC attested the redeem as ${OutputKind[outcome.event.outputKind]}: ` +
          `completeRedeem re-mints the surrendered shares to this wallet (the redeemer)`,
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = executed ? outcome.serializedOutput : new Uint8Array(8);

  // A fresh random mint nonce per settle: the circuit threads it into the mint
  // verbatim, so randomness HERE is what keeps the minted coin unlinkable to the
  // (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeRedeem(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeRedeem settled in tx ${result.public.txId}`);
}

/** Options for {@link completeRedeem}. */
export interface CompleteRedeemOptions {
  /** The redeem request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the redeem's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the redeem request map followed by
 * {@link settleRedeem}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline.
 */
export async function completeRedeem(
  context: VaultContext,
  options: CompleteRedeemOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_REDEEM_REQUESTS_PATH,
  });
  await settleRedeem(context, outcome);
}
