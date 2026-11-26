// Settle side of the Tron approve flow: queue the MPC's attestation of the vault's approve,
// flush it, then close the request through `completeTronApprove` with the request id and
// the output bytes the attestation commits to. An approval surrendered nothing, so no
// verdict mints.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_TRON_APPROVE_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  pollTronRespondBidirectional,
  TronExpectedOutput,
} from "./poll-tron-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved Tron approve outcome: {@link queueAndFlushAttestation}, then
 * `completeTronApprove` with the request id and the output bytes (one zero byte for a
 * failed or unviable approve, whose output the circuit ignores). Every verdict only closes
 * the request. This wallet must be the deployer who started the approval.
 *
 * @param context - The flow context
 * @param outcome - The attested outcome from {@link pollTronRespondBidirectional}
 */
export async function settleTronApprove(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    outcome.succeeded
      ? "Tron approve succeeded: completeTronApprove closes the request"
      : `the MPC attested the Tron approve as ` +
          `${outcome.event.outputKind === OutputKind.executed ? "returning false" : OutputKind[outcome.event.outputKind]}: ` +
          "completeTronApprove closes the request, and the allowance is unchanged",
  );
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);
  const result = await context.vault.callTx.completeTronApprove(
    outcome.event.requestId,
    serializedOutput,
  );
  console.log(`completeTronApprove settled in tx ${result.public.txId}`);
}

/** Options for {@link completeTronApprove}. */
export interface CompleteTronApproveOptions {
  /** The Tron approve request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the Tron approval's attestation resolves, then settle it.
 *
 * @param context - The flow context
 * @param tron - The Tron context the approve's receipt is read through
 * @param options - The request id to settle
 * @throws {Error} If no verifying attestation posts within the poll's deadline
 */
export async function completeTronApprove(
  context: VaultContext,
  tron: TronContext,
  options: CompleteTronApproveOptions,
): Promise<void> {
  const outcome = await pollTronRespondBidirectional(context, tron, {
    requestId: options.requestId,
    requestsPath: VAULT_TRON_APPROVE_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.ApproveResult,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleTronApprove(context, outcome);
}
