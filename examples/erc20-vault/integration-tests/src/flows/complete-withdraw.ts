// Settle side of the withdraw flow: queue the MPC's attestation of the vault's
// transfer, flush it, then settle through `completeWithdraw` with the request id,
// the output bytes the attestation signs, and a fresh RANDOM mint nonce so a
// re-minted coin cannot be linked back to the request.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_WITHDRAW_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved withdraw outcome: {@link queueAndFlushAttestation}, then call
 * `completeWithdraw` with the request id, the output bytes (one zero byte for a
 * failed or unviable transfer, whose output the circuit ignores) and a random
 * mint nonce. A transfer that returned true only closes the request. One that
 * returned false, failed or was unviable re-mints the surrendered amount to this
 * wallet, which must be the withdrawer's either way. The re-mint's coin handling
 * is midnight-js's job: the callTx balances the resulting offer like any other
 * call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 */
export async function settleWithdraw(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    outcome.succeeded
      ? "EVM transfer succeeded: completeWithdraw closes the request"
      : `the MPC attested the transfer as ` +
          `${outcome.event.outputKind === OutputKind.executed ? "returned false" : OutputKind[outcome.event.outputKind]}: ` +
          `completeWithdraw re-mints the surrendered amount to this wallet (the withdrawer)`,
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);

  // A fresh random mint nonce per settle: the circuit threads it into the
  // re-mint verbatim, so randomness HERE is what keeps the re-minted coin
  // unlinkable to the (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeWithdraw(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The withdraw request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the withdrawal's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the withdraw request map followed by
 * {@link settleWithdraw}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline.
 */
export async function completeWithdraw(
  context: VaultContext,
  options: CompleteWithdrawOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
  });
  await settleWithdraw(context, outcome);
}
