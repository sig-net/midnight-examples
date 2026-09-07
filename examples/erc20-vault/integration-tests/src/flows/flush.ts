// The flush entry points — the permissionless, batched drain of the vault's
// queued vault-signed requests.
//
// The four vault-signed flows (withdraw, swap, supply, redeem) no longer mint
// a request id inside `start*`: they validate, burn the surrendered coin and
// append to the contract's `pendingVaultRequests` map. A flush — callable by
// ANYONE, and reading no secret — is what turns a queued entry into a recorded
// SignBidirectionalEvent: it assigns the request-id nonce, assigns the shared
// vault EVM account's transaction nonce, records the event, pins the settle
// view and notifies the MPC.
//
// There is one entry point per KIND, not one that dispatches. A circuit
// contains every branch it might take, so a dispatching drain would charge
// every flusher for all four transaction builders in every slot. Each entry
// point drains ONLY its own kind and skips entries of the others, exactly as
// it skips a key nothing is queued under.

import { pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

/**
 * The contract's flush batch width: the `flush` circuit takes exactly this
 * many keys, because Compact has no unbounded iteration. A shorter batch is
 * padded out with a key nothing is queued under, and those slots are skipped.
 *
 * The width is defined once in the contract, on the `flush` wrapper over
 * `drain<#N>` in erc20-vault.compact, and is baked into the compiled circuit
 * and its proving key. This constant mirrors it: change one and the other must
 * move in the same change, followed by a recompile and a redeploy.
 */
export const FLUSH_BATCH = 5;

/**
 * Which flush entry point to call. The members are the circuit names on the
 * generated contract, so {@link flushVaultRequests} indexes `callTx` with one
 * directly: a kind and its circuit can never drift apart.
 *
 * A batch is homogeneous by construction — a caller holding keys of several
 * kinds makes one call per kind.
 */
export enum FlushKind {
  Withdraws = "flushWithdraws",
  Swaps = "flushSwaps",
  Supplies = "flushSupplies",
  Redeems = "flushRedeems",
}

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
 * It doubles as the refund commitment a flush copies into the settle view, so
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
 * Drain the named queue entries through the entry point for `kind`, padding the
 * batch out to the contract's fixed width. Nothing here is caller-specific:
 * `context` only supplies the connection and the wallet that pays the fee, so a
 * flush of someone else's keys is a normal call, not a privileged one.
 *
 * Every key must name an entry of `kind`: the circuit SKIPS anything else,
 * silently, leaving it queued for its own entry point.
 *
 * @param context - The flow context of whoever is flushing.
 * @param kind - Which entry point to call, and therefore which kind is drained.
 * @param keys - The queue keys to drain, in the order the batch should mint ids.
 * @returns The Midnight transaction id the flush was finalized in.
 * @throws {Error} If `keys` is empty or wider than {@link FLUSH_BATCH}.
 */
export async function flushVaultRequests(
  context: VaultContext,
  kind: FlushKind,
  keys: readonly Uint8Array[],
): Promise<string> {
  if (keys.length === 0) {
    throw new Error(`${kind} needs at least one key`);
  }
  if (keys.length > FLUSH_BATCH) {
    throw new Error(
      `${kind} takes at most ${String(FLUSH_BATCH)} keys per call; got ${String(keys.length)}.`,
    );
  }
  const padded = [...keys, ...Array<Uint8Array>(FLUSH_BATCH - keys.length).fill(DEAD_SLOT_KEY)];
  const result = await context.vault.callTx[kind](padded);
  console.log(`${kind} finalized in tx ${result.public.txId} (${String(keys.length)} drained)`);
  return result.public.txId;
}
