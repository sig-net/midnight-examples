// Wallet-to-wallet transfers with caller-chosen outputs (shielded token
// colours included), which the deploy SDK's NIGHT-only transfer does not
// offer, plus the facade-state poll that observes a transfer land.
import type {
  CombinedTokenTransfer,
  FacadeState,
  TransactionIdentifier,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import type { AccountKeys, NetworkId } from "@sig-net/midnight-contract-deploy";

import { withOperationProgress } from "./operation-progress.ts";
import { ensureTransactionFee } from "./transaction-fees.ts";

// Recipes (balancing plans for submitted transactions) expire 30 min out.
const RECIPE_TTL_MS = 30 * 60 * 1000;

/**
 * Build, balance, sign, prove and submit a wallet-to-wallet token transfer.
 * The facade funds the outputs (and the fee) from its own balances during
 * balancing; proving happens in `finalizeRecipe` via the facade's configured
 * proof server. The receiving wallet discovers the coins from chain data on
 * its next sync — pair with {@link waitForFacadeState} on the receiver.
 *
 * @param facade - A started (and synced) wallet facade that funds, pays for and submits the transfer.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param outputs - The transfer outputs (shielded and/or unshielded), each naming a token type, receiver address and amount.
 * @param networkId - Network used for funding addresses.
 * @returns The submitted transaction's identifier.
 * @throws {Error} If the wallet cannot fund the outputs or fees, proving fails, or the node rejects the transaction.
 */
export async function submitTransferTransaction(
  facade: WalletFacade,
  keys: AccountKeys,
  outputs: CombinedTokenTransfer[],
  networkId: NetworkId,
): Promise<TransactionIdentifier> {
  const expires: number = Date.now() + RECIPE_TTL_MS;
  const prepared = await facade.transferTransaction(
    outputs,
    { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
    { ttl: new Date(expires), payFees: false },
  );
  let recipe = prepared;
  let finalized: Awaited<ReturnType<WalletFacade["finalizeRecipe"]>>;
  try {
    await ensureTransactionFee(
      facade,
      keys,
      networkId,
      prepared.transaction,
      expires,
      "wallet transfer",
    );
    recipe = await facade.balanceUnprovenTransaction(
      prepared.transaction,
      { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
      { ttl: new Date(expires) },
    );
    const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
    finalized = await withOperationProgress(
      "wallet transfer finalisation",
      () => facade.finalizeRecipe(signed),
      expires,
    );
  } catch (error) {
    try {
      await facade.revert(recipe);
    } catch (revertError) {
      console.error(`wallet transfer rollback failed: ${String(revertError)}`);
    }
    throw error;
  }
  // A submission error can leave node acceptance unknown, so keep its pending inputs reserved.
  return withOperationProgress(
    "wallet transfer submission",
    () => facade.submitTransaction(finalized),
    expires,
  );
}

// Polling shares the indexer with the running wallet synchroniser.
const STATE_POLL_INTERVAL_MS = 3_000;

/**
 * Wait until the wallet's synced state satisfies `predicate`, polling the
 * facade. For observing the effect of a submitted transaction (own or
 * incoming) on balances — e.g. a transfer's outputs arriving at the
 * receiving wallet.
 *
 * @param facade - A started wallet facade.
 * @param predicate - Returns true when the awaited state has been reached.
 * @param timeoutMs - Give-up deadline in milliseconds.
 * @returns The first synced state satisfying `predicate`.
 * @throws {Error} If no satisfying state appears within `timeoutMs`.
 */
export async function waitForFacadeState(
  facade: WalletFacade,
  predicate: (state: FacadeState) => boolean,
  timeoutMs = 300_000,
): Promise<FacadeState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await facade.waitForSyncedState();
    if (predicate(state)) return state;
    if (Date.now() >= deadline) {
      throw new Error(`facade state did not satisfy the predicate within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_INTERVAL_MS));
  }
}
