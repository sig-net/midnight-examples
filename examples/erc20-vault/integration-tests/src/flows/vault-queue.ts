import {
  assignedNonce as assignedNonceOf,
  FLUSH_WIDTH,
  flushPending as flushPendingOn,
  flushUntilStamped as flushUntilStampedOn,
  padKeys,
  readVaultLedger,
  seenRequestIds,
  type Stamp,
  unstampedKeys as unstampedKeysOf,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";
import { proveAhead, type ProvenCall } from "./prove-ahead.ts";

export { FLUSH_WIDTH, newQueueKey, padKeys } from "@sig-net/midnight-examples-erc20-vault-contract";

/**
 * The queue key of a request the context's identity made with this binder.
 *
 * @param context - The vault context whose identity made the request.
 * @param binder - The coin nonce or approve binder of the request.
 * @returns The 32-byte queue key.
 */
export function queueKey(context: VaultContext, binder: Uint8Array): Uint8Array {
  return queueKeyOf(context.identity.secretKey, binder);
}

/**
 * Queued keys on the ledger the flush has not stamped yet.
 *
 * @param context - The vault context.
 * @returns The keys a flush can still stamp.
 */
export async function unstampedKeys(context: VaultContext): Promise<Uint8Array[]> {
  return unstampedKeysOf(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
  );
}

/**
 * Folds settled heights into the last seen height, then stamps the first FLUSH_WIDTH
 * unstamped queued keys, whoever queued them.
 *
 * @param context - The vault context.
 * @returns How many keys the flush stamped.
 */
export async function flushPending(context: VaultContext): Promise<number> {
  const carried = await flushPendingOn(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  console.log(`flush of ${String(carried)} pending key(s) finalized`);
  return carried;
}

/**
 * Flushes until the given queued key carries a stamp.
 *
 * @param context - The vault context.
 * @param key - The queued key that needs a stamp.
 * @returns The stamp.
 */
export function flushUntilStamped(context: VaultContext, key: Uint8Array): Promise<Stamp> {
  return flushUntilStampedOn(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    key,
  );
}

/**
 * The EVM nonce the flush assigned to a key.
 *
 * @param context - The vault context.
 * @param key - The flushed queue key.
 * @returns The assigned nonce.
 */
export async function assignedNonce(context: VaultContext, key: Uint8Array): Promise<bigint> {
  return assignedNonceOf(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    key,
  );
}

/**
 * Proves a flush of the given keys against the ledger as it is now and returns it unsubmitted.
 *
 * @param context - The vault context.
 * @param keys - The queued keys the flush stamps.
 * @returns The proven flush, to submit with `submitProven`.
 */
export async function proveFlush(
  context: VaultContext,
  keys: readonly Uint8Array[],
): Promise<ProvenCall> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const seen = seenRequestIds(state).slice(0, FLUSH_WIDTH);
  return proveAhead(context, "flush", [padKeys(keys), padKeys(seen)]);
}
