// `refundUnsentTronWithdraw`: the withdrawer takes back the amount of a Tron withdrawal
// nobody sent while its window allowed. The start burned the coin, and from block time
// h - tronWithdrawSendMinRemainingSeconds() on, h the expiration's whole seconds,
// `sendTronWithdraw` refuses the withdrawal for good. From that block time the vault
// re-mints the amount to the withdrawer (the fee stays taken) and drops the withdrawal.
import { pureCircuits, readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

/**
 * The first time, in milliseconds, at which the vault refunds an unsent Tron withdrawal
 * expiring at `expiration`: the first block time at which `sendTronWithdraw` refuses it.
 *
 * @param expiration - The withdrawal's expiration, in Tron's milliseconds
 * @returns The opening time in milliseconds since the epoch, on a whole second
 */
export function tronWithdrawRefundOpensAtMs(expiration: bigint): bigint {
  return (expiration / 1000n - pureCircuits.tronWithdrawSendMinRemainingSeconds()) * 1000n;
}

/** Options for {@link refundUnsentTronWithdraw}. */
export interface RefundUnsentTronWithdrawOptions {
  /** The input index the withdrawal was queued under (`QueuedTronWithdraw.inIndex`). */
  readonly inIndex: bigint;
}

/**
 * Wait until the vault refunds the unsent Tron withdrawal queued under `options.inIndex`,
 * then call `refundUnsentTronWithdraw` with a random mint nonce, which re-mints the
 * surrendered amount to this wallet. The wallet must be the withdrawer's.
 *
 * @param context - The flow context
 * @param options - The withdrawal's input index
 * @throws {Error} If no Tron withdrawal is open under the index, the vault refuses the
 *   refund (it was sent, or the caller is not the withdrawer), or the withdrawal is still
 *   open after it
 */
export async function refundUnsentTronWithdraw(
  context: VaultContext,
  options: RefundUnsentTronWithdrawOptions,
): Promise<void> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.tronWithdrawArgsMap.member(options.inIndex)) {
    throw new Error(`no Tron withdrawal is open under input index ${String(options.inIndex)}`);
  }
  const opensAt = tronWithdrawRefundOpensAtMs(
    state.tronWithdrawArgsMap.lookup(options.inIndex).tx.expiration,
  );
  const waitMs = Number(opensAt - BigInt(Date.now()));
  if (waitMs > 0) {
    console.log(`refund opens at ${new Date(Number(opensAt)).toISOString()}, waiting`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const result = await context.vault.callTx.refundUnsentTronWithdraw(
    options.inIndex,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  console.log(`refundUnsentTronWithdraw re-minted in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (after.tronWithdrawArgsMap.member(options.inIndex)) {
    throw new Error(`Tron withdrawal ${String(options.inIndex)} is still open after its refund`);
  }
}
