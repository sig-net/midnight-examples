import { OutputKind, requestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  readVaultLedger,
  type TronSwapRequest,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/** */
export interface TronSwapSettlement {
  readonly request: TronSwapRequest;
  readonly amountIn: bigint | undefined;
}

/**
 * @param context - The flow context, of the wallet that started the swap
 * @param outcome - The attested outcome of the swap
 * @returns The settled request and the input an executed swap spent
 * @throws {Error} If the request is not open on the vault ledger
 */
export async function settleTronSwap(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<TronSwapSettlement> {
  const requestId = outcome.event.requestId;
  console.log(`request id:      ${requestIdHex(requestId)}`);
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.evictionMap.member(requestId)) {
    throw new Error(`Tron swap ${requestIdHex(requestId)} is not open on the vault ledger`);
  }
  const { entry } = ledger.outputRequestBuffer.lookup(ledger.evictionMap.lookup(requestId));
  const { request } = ledger.tronSwapArgsMap.lookup(entry.inIndex);

  const amountIn =
    outcome.event.outputKind === OutputKind.executed
      ? pureCircuits.swapAmountIn(outcome.serializedOutput)
      : undefined;
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = amountIn === undefined ? new Uint8Array(32) : outcome.serializedOutput;
  const result = await context.vault.callTx.completeTronSwap(
    requestId,
    serializedOutput,
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.getRandomValues(new Uint8Array(32)),
  );
  console.log(`completeTronSwap settled in tx ${result.public.txId}`);
  return { request, amountIn };
}
