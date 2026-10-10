// Queue and flush side of every settle: hand the MPC's attestation to the queue
// circuit, then flush it into outputAttestationBuffer, where the action's complete
// circuit consumes it with the output.
import { respondBidirectionalEventToCircuitInput } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";
import type { RespondOutcome } from "./respond-output.ts";
import { flushUntil } from "./vault-queue.ts";

/**
 * Queue a resolved outcome's attestation (the event in circuit-input form; its
 * signature covers the output's width and hash, so the output stays with the
 * complete circuit) and flush until the vault holds it under the request id.
 * Both steps are permissionless, and the caller's wallet pays for them. A rerun
 * finds the attestation already queued or flushed and carries on from there.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from `pollRespondBidirectional`.
 * @throws {Error} If the attestation does not reach `outputAttestationBuffer`.
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
    const queued = await context.vault.callTx.queueAttestation(
      respondBidirectionalEventToCircuitInput(outcome.event),
    );
    console.log(`attestation queued in tx ${queued.public.txId}`);
  }
  await flushUntil(context, (state) => state.outputAttestationBuffer.member(requestId), {
    inIndexes: [],
    requestIds: [requestId],
  });
}
