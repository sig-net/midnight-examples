// `refundUnsentTronSupply` and `refundUnsentTronRedeem`: the requester takes back the coin
// of a Tron supply or redeem nobody sent while its window allowed, as the withdrawer does
// with refundUnsentTronWithdraw. From block time h - tronSendMinRemainingSeconds() on, h
// the expiration's whole seconds, the action's send refuses the request for good, and the
// vault re-mints the surrendered amount or shares (the fee stays taken).
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";
import { waitForTronRefund } from "./tron-vault-request.ts";

/** Options for {@link refundUnsentTronSupply} and {@link refundUnsentTronRedeem}. */
export interface RefundUnsentTronLendOptions {
  /** The input index the request was queued under (`QueuedTronRequest.inIndex`). */
  readonly inIndex: bigint;
}

/**
 * Wait until the vault refunds the unsent Tron supply queued under `options.inIndex`, then
 * call `refundUnsentTronSupply` with a random mint nonce, which re-mints the surrendered
 * underlying amount to this wallet. The wallet must be the supplier's.
 *
 * @param context - The flow context
 * @param options - The supply's input index
 * @throws {Error} If no Tron supply is open under the index, the vault refuses the refund
 *   (it was sent, or the caller is not the supplier), or the supply is still open after it
 */
export async function refundUnsentTronSupply(
  context: VaultContext,
  options: RefundUnsentTronLendOptions,
): Promise<void> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.tronSupplyArgsMap.member(options.inIndex)) {
    throw new Error(`no Tron supply is open under input index ${String(options.inIndex)}`);
  }
  await waitForTronRefund(state.tronSupplyArgsMap.lookup(options.inIndex).tx.expiration);
  const result = await context.vault.callTx.refundUnsentTronSupply(
    options.inIndex,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  console.log(`refundUnsentTronSupply re-minted in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (after.tronSupplyArgsMap.member(options.inIndex)) {
    throw new Error(`Tron supply ${String(options.inIndex)} is still open after its refund`);
  }
}

/**
 * Wait until the vault refunds the unsent Tron redeem queued under `options.inIndex`, then
 * call `refundUnsentTronRedeem` with a random mint nonce, which re-mints the surrendered
 * shares to this wallet. The wallet must be the redeemer's.
 *
 * @param context - The flow context
 * @param options - The redeem's input index
 * @throws {Error} If no Tron redeem is open under the index, the vault refuses the refund
 *   (it was sent, or the caller is not the redeemer), or the redeem is still open after it
 */
export async function refundUnsentTronRedeem(
  context: VaultContext,
  options: RefundUnsentTronLendOptions,
): Promise<void> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.tronRedeemArgsMap.member(options.inIndex)) {
    throw new Error(`no Tron redeem is open under input index ${String(options.inIndex)}`);
  }
  await waitForTronRefund(state.tronRedeemArgsMap.lookup(options.inIndex).tx.expiration);
  const result = await context.vault.callTx.refundUnsentTronRedeem(
    options.inIndex,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  console.log(`refundUnsentTronRedeem re-minted in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (after.tronRedeemArgsMap.member(options.inIndex)) {
    throw new Error(`Tron redeem ${String(options.inIndex)} is still open after its refund`);
  }
}
