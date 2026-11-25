import { pureCircuits, readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

/**
 * @param expiration - The swap's expiration, in Tron's milliseconds
 * @returns The first time, in milliseconds since the epoch, at which the vault refunds the
 *   unsent swap
 */
export function tronSwapRefundOpensAtMs(expiration: bigint): bigint {
  return (expiration / 1000n - pureCircuits.tronSwapSendMinRemainingSeconds()) * 1000n;
}

/**
 * @param context - The flow context, of the wallet that started the swap
 * @param inIndex - The input index the swap was queued under
 * @throws {Error} If no Tron swap is open under the index, or it is still open after the refund
 */
export async function refundUnsentTronSwap(context: VaultContext, inIndex: bigint): Promise<void> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.tronSwapArgsMap.member(inIndex)) {
    throw new Error(`no Tron swap is open under input index ${String(inIndex)}`);
  }
  const opensAt = tronSwapRefundOpensAtMs(state.tronSwapArgsMap.lookup(inIndex).tx.expiration);
  const waitMs = Number(opensAt - BigInt(Date.now()));
  if (waitMs > 0) {
    console.log(`refund opens at ${new Date(Number(opensAt)).toISOString()}, waiting`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const result = await context.vault.callTx.refundUnsentTronSwap(
    inIndex,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  console.log(`refundUnsentTronSwap re-minted in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (after.tronSwapArgsMap.member(inIndex)) {
    throw new Error(`Tron swap ${String(inIndex)} is still open after its refund`);
  }
}
