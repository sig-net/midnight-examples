// Settle side of the nonce replacement flow: queue the MPC's attestation of the
// vault's self-transfer, flush it, then close the request through
// `completeReplaceNonce` with the request id and the output bytes the attestation
// signs.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_REPLACE_NONCE_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved replacement outcome: {@link queueAndFlushAttestation}, then call
 * `completeReplaceNonce` with the request id and the output bytes (one zero byte for
 * a failed or unviable self-transfer, whose output the circuit ignores). Every
 * verdict only closes the request, as the replacement surrendered nothing. This
 * wallet must hold the deployer's identity, which started it.
 *
 * @param context - The flow context, holding the deployer's identity.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 */
export async function settleReplaceNonce(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    `the MPC attested the self-transfer as ${OutputKind[outcome.event.outputKind]}: ` +
      "completeReplaceNonce closes the request",
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);

  const result = await context.vault.callTx.completeReplaceNonce(
    outcome.event.requestId,
    serializedOutput,
  );
  console.log(`completeReplaceNonce settled in tx ${result.public.txId}`);
}

/** Options for {@link completeReplaceNonce}. */
export interface CompleteReplaceNonceOptions {
  /** The replacement request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the replacement's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the nonce replacement map followed by
 * {@link settleReplaceNonce}.
 *
 * @param context - The flow context, holding the deployer's identity.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's deadline.
 */
export async function completeReplaceNonce(
  context: VaultContext,
  options: CompleteReplaceNonceOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_REPLACE_NONCE_REQUESTS_PATH,
  });
  await settleReplaceNonce(context, outcome);
}
