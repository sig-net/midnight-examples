// `flush` — the permissionless, batched drain of the vault's queued
// vault-signed requests.
//
// The four vault-signed flows (withdraw, swap, supply, redeem) no longer mint
// a request id inside `start*`: they validate, burn the surrendered coin and
// append to the contract's `pendingVaultRequests` map. `flush` — callable by
// ANYONE, and reading no secret — is what turns a queued entry into a recorded
// SignBidirectionalEvent: it assigns the request-id nonce, assigns the shared
// vault EVM account's transaction nonce, records the event, pins the settle
// view and notifies the MPC.

import { pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

/**
 * The contract's flush batch width: the `flush` circuit takes exactly this
 * many keys, because Compact has no unbounded iteration. A shorter batch is
 * padded out with a key nothing is queued under, and those slots are skipped.
 */
export const FLUSH_BATCH = 2;

/**
 * The padding key. Queue keys are `refundCommitment` digests, so an all-`0xff`
 * key is one no honest request can ever occupy; a slot holding it is skipped,
 * consuming neither a request nonce nor — crucially — an EVM nonce.
 */
const DEAD_SLOT_KEY = new Uint8Array(32).fill(0xff);

/**
 * The key a `start*` circuit queues this caller's request under: the caller's
 * identity secret bound to the nonce of the coin the request surrendered.
 * Computed through the COMPILED `refundCommitment` circuit, never a TS
 * re-implementation, so it is a lockstep check of the in-circuit derivation.
 *
 * It doubles as the refund commitment `flush` copies into the settle view, so
 * handing it to a flusher gives that flusher no claim on the refund: the
 * preimage (the secret) never leaves the requester.
 *
 * @param context - The flow context, holding the caller's identity secret.
 * @param coinNonce - The nonce of the coin the `start*` call surrendered.
 * @returns The 32-byte queue key.
 */
export function vaultQueueKey(context: VaultContext, coinNonce: Uint8Array): Uint8Array {
  return pureCircuits.refundCommitment(context.identity.secretKey, coinNonce);
}

/**
 * Drain the named queue entries, padding the batch out to the contract's fixed
 * width. Nothing here is caller-specific: `context` only supplies the
 * connection and the wallet that pays the fee, so a flush of someone else's
 * keys is a normal call, not a privileged one.
 *
 * @param context - The flow context of whoever is flushing.
 * @param keys - The queue keys to drain, in the order the batch should mint ids.
 * @returns The Midnight transaction id the flush was finalized in.
 * @throws {Error} If `keys` is empty or wider than {@link FLUSH_BATCH}.
 */
export async function flushVaultRequests(
  context: VaultContext,
  keys: readonly Uint8Array[],
): Promise<string> {
  if (keys.length === 0) {
    throw new Error("flush needs at least one key");
  }
  if (keys.length > FLUSH_BATCH) {
    throw new Error(
      `flush takes at most ${String(FLUSH_BATCH)} keys per call; got ${String(keys.length)}.`,
    );
  }
  const padded = [...keys, ...Array<Uint8Array>(FLUSH_BATCH - keys.length).fill(DEAD_SLOT_KEY)];
  const result = await context.vault.callTx.flush(padded);
  console.log(`flush finalized in tx ${result.public.txId} (${String(keys.length)} drained)`);
  return result.public.txId;
}
