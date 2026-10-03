// Queue and flush side of every settle: hand the MPC's attestation to the queue
// circuit for its output's width, then flush it into outputAttestationBuffer, where
// the action's complete circuit consumes it.
import { requestIdHex, respondBidirectionalEventToCircuitInput } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";
import type { RespondOutcome } from "./respond-output.ts";
import { flushUntil } from "./vault-queue.ts";

/**
 * Queue a resolved outcome's attestation (the event in circuit-input form and
 * the output bytes its signature verified over) with the queue circuit for the
 * output's width, and flush until the vault holds it under the request id. Both
 * steps are permissionless, and the caller's wallet pays for them. A rerun finds
 * the attestation already queued or flushed and carries on from there.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from `pollRespondBidirectional`.
 * @throws {Error} If the output has a width no queue circuit takes, or the
 *   attestation does not reach `outputAttestationBuffer`.
 */
export async function queueAndFlushAttestation(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  const requestId = outcome.event.requestId;
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (
    !ledger.inputAttestationBuffer.member(requestId) &&
    !ledger.outputAttestationBuffer.member(requestId)
  ) {
    const output = outcome.serializedOutput;
    if (output.length !== 0 && output.length !== 1 && output.length !== 8) {
      throw new Error(
        `no queue circuit takes a ${String(output.length)}-byte output (request ${requestIdHex(requestId)})`,
      );
    }
    const attestation = respondBidirectionalEventToCircuitInput(outcome.event);
    const queued =
      output.length === 0
        ? await context.vault.callTx.queueAttestation0(attestation, output)
        : output.length === 1
          ? await context.vault.callTx.queueAttestation1(attestation, output)
          : await context.vault.callTx.queueAttestation8(attestation, output);
    console.log(`attestation queued in tx ${queued.public.txId}`);
  }
  await flushUntil(context, (state) => state.outputAttestationBuffer.member(requestId), {
    inIndexes: [],
    requestIds: [requestId],
  });
}
