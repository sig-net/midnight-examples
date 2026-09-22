import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";

import type { DeployedVaultContract } from "./contract-surface.ts";
import { pureCircuits, type Stamp } from "./managed/erc20-vault/contract/index.js";
import { readVaultLedger, type VaultLedgerState } from "./vault-ledger.ts";

/** Keys one `flush` call carries. */
export const FLUSH_WIDTH = 20;

/**
 * Pads a key batch with zero keys to the flush width.
 *
 * @param keys - The queue keys to flush.
 * @returns The vector the flush circuit takes.
 * @throws {Error} When more keys than the flush width are given.
 */
export function padKeys(keys: readonly Uint8Array[]): Uint8Array[] {
  if (keys.length > FLUSH_WIDTH) {
    throw new Error(
      `a flush takes at most ${String(FLUSH_WIDTH)} keys; got ${String(keys.length)}`,
    );
  }
  return [...keys, ...Array<Uint8Array>(FLUSH_WIDTH - keys.length).fill(new Uint8Array(32))];
}

/**
 * A fresh queue key for a withdraw, swap, supply or redeem: 32 random bytes.
 *
 * @returns The key to queue the request under.
 */
export function newQueueKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Whether a queued request or settle view belongs to this identity: its
 * commitment is the refund commitment of the secret over its key.
 *
 * @param secretKey - The requester's identity secret key.
 * @param key - The request's queue key.
 * @param commitment - The commitment the ledger stores for the request.
 * @returns True when the secret produced that commitment.
 */
export function ownsRequest(
  secretKey: Uint8Array,
  key: Uint8Array,
  commitment: Uint8Array,
): boolean {
  const mine = pureCircuits.refundCommitment(secretKey, key);
  return mine.length === commitment.length && mine.every((byte, i) => byte === commitment[i]);
}

/**
 * The queued keys that belong to this identity, in ledger order.
 *
 * @param state - The vault ledger state.
 * @param secretKey - The requester's identity secret key.
 * @returns The keys of this identity's queued requests.
 */
export function myQueuedKeys(state: VaultLedgerState, secretKey: Uint8Array): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (const [key, entry] of state.pendingVaultRequests) {
    if (ownsRequest(secretKey, key, entry.commitment)) keys.push(key);
  }
  return keys;
}

/**
 * Queued keys the flush has not stamped yet, in ledger order.
 *
 * @param state - The vault ledger state.
 * @returns The keys a flush can still stamp.
 */
export function unstampedKeys(state: VaultLedgerState): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (const [key] of state.pendingVaultRequests) {
    if (!state.stamps.member(key)) keys.push(key);
  }
  return keys;
}

/**
 * Settled request ids whose attested block height the flush has not folded into the
 * vault's last seen height yet, in ledger order.
 *
 * @param state - The vault ledger state.
 * @returns The request ids a flush can still fold.
 */
export function seenRequestIds(state: VaultLedgerState): Uint8Array[] {
  const ids: Uint8Array[] = [];
  for (const [requestId] of state.seenEvmHeights) ids.push(requestId);
  return ids;
}

/**
 * The stamp a flush put on a queued key: its EVM nonce, zero for a deposit, and the
 * vault's last seen block height at that time.
 *
 * @param state - The vault ledger state.
 * @param key - The queued key.
 * @returns The stamp.
 * @throws {Error} When the key has no stamp yet.
 */
export function stampOf(state: VaultLedgerState, key: Uint8Array): Stamp {
  if (!state.stamps.member(key)) {
    throw new Error("the request key has no stamp; flush first");
  }
  return state.stamps.lookup(key);
}

/**
 * The EVM nonce a flush assigned to a queued key.
 *
 * @param state - The vault ledger state.
 * @param key - The queued key.
 * @returns The assigned nonce.
 * @throws {Error} When the key has no stamp yet.
 */
export function assignedNonce(state: VaultLedgerState, key: Uint8Array): bigint {
  return stampOf(state, key).evmNonce;
}

/**
 * Folds up to FLUSH_WIDTH settled heights into the last seen height, then stamps the
 * first FLUSH_WIDTH unstamped queued keys on the ledger, whoever queued them.
 *
 * @param vault - The found vault contract to call.
 * @param publicDataProvider - The provider the ledger is read through.
 * @param vaultContractAddress - The vault's contract address.
 * @returns How many keys the flush stamped.
 */
export async function flushPending(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
): Promise<number> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  const batch = unstampedKeys(state).slice(0, FLUSH_WIDTH);
  const seen = seenRequestIds(state).slice(0, FLUSH_WIDTH);
  await vault.callTx.flush(padKeys(batch), padKeys(seen));
  return batch.length;
}

/**
 * Flushes until the given queued key carries a stamp. A flush that loses its block to
 * another flush is retried.
 *
 * @param vault - The found vault contract to call.
 * @param publicDataProvider - The provider the ledger is read through.
 * @param vaultContractAddress - The vault's contract address.
 * @param key - The queued key that needs a stamp.
 * @param attempts - How many flushes to try.
 * @returns The stamp.
 * @throws {Error} When the key is still unstamped after the attempts.
 */
export async function flushUntilStamped(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  key: Uint8Array,
  attempts = 5,
): Promise<Stamp> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
    if (state.stamps.member(key)) return state.stamps.lookup(key);
    try {
      await flushPending(vault, publicDataProvider, vaultContractAddress);
    } catch (error) {
      console.log(
        `flush attempt ${String(attempt + 1)} lost: ${String(error).split("\n")[0] ?? ""}`,
      );
    }
  }
  return stampOf(await readVaultLedger(publicDataProvider, vaultContractAddress), key);
}
