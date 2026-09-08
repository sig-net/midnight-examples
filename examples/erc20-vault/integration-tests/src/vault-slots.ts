// The off-chain half of the vault's EVM nonce allocator, shared by every
// two-phase flow (withdraw, swap, supply, redeem, and both approves).
//
// The vault signs every non-deposit EVM transaction from ONE pooled account,
// so each request needs its own contiguous EVM account nonce. Reading a
// counter to hand one out pins that cell, which serialises the whole vault —
// so the contract splits each request in two instead:
//
//   phase 1 (`request*`) parks the parameters under a per-request KEY and
//   appends that key to the `slots` HistoricMerkleTree. The insert lands at
//   the tree's first free leaf AT APPLY TIME and reads nothing shared, so
//   concurrent phase-1 calls commute.
//
//   phase 2 (`assign*`) presents a Merkle path proving where the key landed.
//   The path's `goes_left` bits ARE the leaf index in binary, so the index —
//   and with it the EVM nonce (`evmNonceBase + index`) and the request nonce
//   (the index itself) — is PROVEN rather than read.
//
// Which means a caller cannot know its request id until phase 1 has APPLIED:
// the slot index is decided by the ledger, not by the caller. Flows therefore
// run phase 1, re-read the ledger, resolve the slot here, and only then
// reconstruct the expected request record.

import type { MerkleTreePath } from "@midnight-ntwrk/compact-runtime";
import { bytesToHex } from "@sig-net/midnight";
import { pureCircuits, readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "./vault-context.ts";

/**
 * The request key phase 1 parks under and phase 2 claims: the compiled
 * `requestCommitment(callerSecretKey, nonce)`, never a TS re-implementation.
 * It is also the settle-view `commitment` every `complete*`/`refund*` proves,
 * which is why the caller must keep `nonce` around until the request settles.
 *
 * @param context - The flow context, whose identity holds the caller's secret.
 * @param nonce - The value keying this request: the surrendered coin's nonce
 *   for the four value flows, a caller-chosen random salt for the approves
 *   (they surrender no coin). Must be a value this caller has not used before.
 * @returns The 32-byte request key.
 */
export function vaultRequestKey(context: VaultContext, nonce: Uint8Array): Uint8Array {
  return pureCircuits.requestCommitment(context.identity.secretKey, nonce);
}

/**
 * Fold a slot path's `goes_left` bits back into the leaf index, LSB FIRST:
 * `path.path[0]` is the sibling at the LEAF level, so it carries bit 0, and
 * `goes_left === true` means "this node is the left child", i.e. a 0 bit.
 *
 * Mirrors the contract's `accumulateSlotIndexBit` fold exactly. Folding the
 * other way (`acc * 2 + bit`) would reconstruct the index bit-reversed — a
 * bijection, but one that scatters EVM nonces across the whole 2^20 range.
 *
 * @param path - The Merkle path `slots.findPathForLeaf` returned.
 * @returns The leaf's index in the allocator tree.
 */
export function slotIndexFromPath(path: MerkleTreePath<Uint8Array>): bigint {
  let index = 0n;
  let weight = 1n;
  for (const entry of path.path) {
    if (!entry.goes_left) index += weight;
    weight *= 2n;
  }
  return index;
}

/** The allocator slot a parked request owns, and the two nonces phase 2 derives from it. */
export interface RequestSlot {
  /** The request key, i.e. the allocator leaf: `requestCommitment(secret, nonce)`. */
  readonly key: Uint8Array;
  /** The membership proof phase 2 presents; the argument the `assign*` circuits take. */
  readonly path: MerkleTreePath<Uint8Array>;
  /** The leaf's index, which is also the request nonce the recorded event carries. */
  readonly index: bigint;
  /** The EVM account nonce this slot owns: `evmNonceBase + index`. */
  readonly evmNonce: bigint;
}

/**
 * Resolve the slot a phase-1 call just parked `key` in: re-read the vault
 * ledger, build the Merkle path for the leaf, and derive the index plus the
 * EVM nonce the phase-2 circuit will prove.
 *
 * Call this only AFTER the phase-1 transaction has finalized — the leaf does
 * not exist until then, and its index is chosen at apply time.
 *
 * @param context - The flow context.
 * @param key - The request key from {@link vaultRequestKey}.
 * @returns The slot, ready to hand to the flow's `assign*` call.
 * @throws {Error} If `key` is not a leaf of the allocator tree, i.e. phase 1
 *   has not applied yet. An already-assigned key still resolves: the leaf
 *   STAYS in the tree forever (removing it would rebind an issued index), and
 *   it is the contract's tombstone on the parked entry, not the tree, that
 *   rejects a second phase 2.
 */
export async function resolveRequestSlot(
  context: VaultContext,
  key: Uint8Array,
): Promise<RequestSlot> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const path = state.slots.findPathForLeaf(key);
  if (path === undefined) {
    throw new Error(
      `request key ${bytesToHex(key)} is not in the vault's allocator tree — ` +
        `has phase 1 finalized?`,
    );
  }
  const index = slotIndexFromPath(path);
  return { key, path, index, evmNonce: state.evmNonceBase + index };
}
