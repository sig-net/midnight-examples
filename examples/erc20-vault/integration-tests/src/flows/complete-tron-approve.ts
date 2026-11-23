import { OutputKind, requestIdHex } from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * @param context - The flow context, of the deployer who started the approval
 * @param outcome - The attested outcome of the approval
 */
export async function settleTronApprove(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);
  const result = await context.vault.callTx.completeTronApprove(
    outcome.event.requestId,
    serializedOutput,
  );
  console.log(`completeTronApprove settled in tx ${result.public.txId}`);
}
