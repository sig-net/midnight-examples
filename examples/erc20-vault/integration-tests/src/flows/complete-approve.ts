// Settle side of the approve flow: queue the MPC's attestation of the vault's
// approve, flush it, then close the request through `completeApprove` with the
// request id and the output bytes the attestation signs. An approval surrendered
// nothing, so no verdict mints.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_APPROVE_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved approve outcome: {@link queueAndFlushAttestation}, then call
 * `completeApprove` with the request id and the output bytes (one zero byte for
 * a failed or unviable approve, whose output the circuit ignores). Every verdict
 * only closes the request. This wallet must be the deployer who started the
 * approval.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 */
export async function settleApprove(context: VaultContext, outcome: RespondOutcome): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    outcome.succeeded
      ? "EVM approve succeeded: completeApprove closes the request"
      : `the MPC attested the approve as ` +
          `${outcome.event.outputKind === OutputKind.executed ? "returned false" : OutputKind[outcome.event.outputKind]}: ` +
          `completeApprove closes the request, and the allowance is unchanged`,
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);

  const result = await context.vault.callTx.completeApprove(
    outcome.event.requestId,
    serializedOutput,
  );
  console.log(`completeApprove settled in tx ${result.public.txId}`);
}

/** Options for {@link completeApprove}. */
export interface CompleteApproveOptions {
  /** The approve request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the approval's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the approve request map followed by
 * {@link settleApprove}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline.
 */
export async function completeApprove(
  context: VaultContext,
  options: CompleteApproveOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_APPROVE_REQUESTS_PATH,
  });
  await settleApprove(context, outcome);
}
