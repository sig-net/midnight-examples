import {
  CallTxFailedError,
  createCallTxOptions,
  createUnprovenCallTx,
  submitTx,
} from "@midnight-ntwrk/midnight-js/contracts";
import { getNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  encodeContractKeyLocation,
  FailFallible,
  hashVerifierKey,
  SucceedEntirely,
} from "@midnight-ntwrk/midnight-js/types";
import {
  communicationCommitmentRandomness,
  ContractCallPrototype,
  ContractState,
  Intent,
  Transaction,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { bytesToHex } from "@sig-net/midnight";

import {
  VAULT_PRIVATE_STATE_ID,
  type VaultCompiledContract,
  type VaultProviders,
} from "./contract-surface.ts";
import {
  Action,
  FlushChannel,
  type FlushSlot,
  pureCircuits,
} from "./managed/erc20-vault/contract/index.js";
import { readVaultLedger, type VaultLedgerState } from "./vault-ledger.ts";

/** Slots one `flushQueue` call carries. */
export const FLUSH_WIDTH = 10;

/**
 * The slot vector `flushQueue` takes: attestation slots first, so the request slots
 * behind them record those heights as their `lastSeen`, then empty slots to the width.
 *
 * @param inIndexes - The input buffer indexes of the requests to flush.
 * @param requestIds - The request ids of the queued attestations to flush.
 * @returns The padded slot vector.
 * @throws {Error} When more items than the flush width are given.
 */
export function flushSlots(
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): FlushSlot[] {
  if (inIndexes.length + requestIds.length > FLUSH_WIDTH) {
    throw new Error(
      `a flush takes at most ${String(FLUSH_WIDTH)} items; got ${String(inIndexes.length + requestIds.length)}`,
    );
  }
  const empty = new Uint8Array(32);
  return [
    ...requestIds.map((requestId) => ({
      channel: FlushChannel.attestation,
      inIndex: 0n,
      requestId,
    })),
    ...inIndexes.map((inIndex) => ({
      channel: FlushChannel.request,
      inIndex,
      requestId: empty,
    })),
    ...Array.from({ length: FLUSH_WIDTH - inIndexes.length - requestIds.length }, () => ({
      channel: FlushChannel.empty,
      inIndex: 0n,
      requestId: empty,
    })),
  ];
}

/**
 * A fresh input buffer index for a start circuit: 64 random bits.
 *
 * @returns The index to queue the request under.
 */
export function newInputIndex(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0);
}

/**
 * The output buffer index a queued caller-signed request moves to when flushed,
 * computed by the compiled `requestIndex` circuit from the entry the start circuit
 * wrote. A vault-signed request's index covers the nonce its flush assigns, so it
 * has none before the flush: read it afterwards with {@link flushedRequestIndex}.
 *
 * @param state - The vault ledger state.
 * @param inIndex - The request's input buffer index.
 * @returns The request index.
 * @throws {Error} When no request is queued under the index, or the queued
 *   request is vault-signed.
 */
export function queuedRequestIndex(state: VaultLedgerState, inIndex: bigint): Uint8Array {
  if (!state.inputRequestBuffer.member(inIndex)) {
    throw new Error(`no request is queued under input index ${String(inIndex)}`);
  }
  const entry = state.inputRequestBuffer.lookup(inIndex);
  if (entry.useNextVaultAccountNonce) {
    throw new Error(
      `the request under input index ${String(inIndex)} is vault-signed: its index covers the nonce the flush assigns, read it with flushedRequestIndex once flushed`,
    );
  }
  return pureCircuits.requestIndex(entry);
}

/**
 * The output buffer index of the open `action` request queued under `inIndex`. The
 * action's args map holds the index from start to complete, so at most one open
 * request of the action carries it. The entry under the index holds the EVM nonce
 * the flush assigned.
 *
 * @param state - The vault ledger state.
 * @param action - The request's action.
 * @param inIndex - The input buffer index the request was queued under.
 * @returns The request index.
 * @throws {Error} When no open request of `action` carries the index.
 */
export function flushedRequestIndex(
  state: VaultLedgerState,
  action: Action,
  inIndex: bigint,
): Uint8Array {
  for (const [index, { entry }] of state.outputRequestBuffer) {
    if (entry.action === action && entry.inIndex === inIndex) return index;
  }
  throw new Error(`no open ${Action[action]} request carries input index ${String(inIndex)}`);
}

const FLUSH_TTL_MS = 5 * 60_000;

// midnight-js sections a call's transcript before the wallet adds its fee payment, so
// a flush carrying one item stays in the guaranteed section and the payment then
// pushes it past the node's time-to-dismiss cap (error 231). With the whole
// transcript fallible, only the proof check and the payment count toward that cap.
async function submitFlush(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
  slots: FlushSlot[],
): Promise<void> {
  const call = await createUnprovenCallTx(providers, {
    ...createCallTxOptions(
      compiledContract,
      "flushQueue",
      vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      undefined,
      [slots],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  const [guaranteed, fallible] = call.public.partitionedTranscript;
  const raw = await providers.publicDataProvider.queryContractState(vaultContractAddress);
  // The indexer's state is the runtime's ContractState class, and ContractCallPrototype
  // accepts only the ledger's own ContractOperation: round-trip through bytes.
  const state = raw && ContractState.deserialize(raw.serialize());
  const operation = state?.operation("flushQueue");
  if (!operation?.verifierKey) {
    throw new Error(`flushQueue has no verifier key on chain at ${vaultContractAddress}`);
  }
  const prototype = new ContractCallPrototype(
    vaultContractAddress,
    "flushQueue",
    operation,
    undefined,
    guaranteed ?? fallible,
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationCommitmentRandomness(),
    encodeContractKeyLocation({
      contractAddress: vaultContractAddress,
      circuitId: "flushQueue",
      verifierKeyHash: hashVerifierKey(operation.verifierKey),
    }),
  );
  const intent = Intent.new(new Date(Date.now() + FLUSH_TTL_MS)).addCall(prototype);
  const unprovenTx = Transaction.fromPartsRandomized(getNetworkId(), undefined, undefined, intent);
  const finalized = await submitTx(providers, { unprovenTx, circuitId: "flushQueue" });
  if (finalized.status !== SucceedEntirely) {
    throw new CallTxFailedError(finalized, "flushQueue");
  }
}

/** Queued items a flush carries ahead of every other waiting item. */
export interface FlushItems {
  /** Input buffer indexes of queued requests. */
  readonly inIndexes: readonly bigint[];
  /** Request ids of queued attestations. */
  readonly requestIds: readonly Uint8Array[];
}

// Up to FLUSH_WIDTH items that would move: `first` ahead of the rest, attestations ahead
// of requests. A caller-signed request whose request index is open, or taken by an
// earlier request in the batch, would fail the flush, so it is left out. A vault-signed
// request never is: the flush gives it a nonce no other request holds.
function movableItems(state: VaultLedgerState, first: FlushItems): FlushItems {
  const requestIds: Uint8Array[] = [];
  const inIndexes: bigint[] = [];
  const takenRequestIds = new Set<string>();
  const takenInIndexes = new Set<bigint>();
  const takenRequestIndexes = new Set<string>();
  const addAttestation = (requestId: Uint8Array): void => {
    const hex = bytesToHex(requestId);
    if (requestIds.length + inIndexes.length === FLUSH_WIDTH || takenRequestIds.has(hex)) return;
    if (!state.inputAttestationBuffer.member(requestId)) return;
    takenRequestIds.add(hex);
    requestIds.push(requestId);
  };
  const addRequest = (inIndex: bigint): void => {
    if (requestIds.length + inIndexes.length === FLUSH_WIDTH || takenInIndexes.has(inIndex)) return;
    if (!state.inputRequestBuffer.member(inIndex)) return;
    const entry = state.inputRequestBuffer.lookup(inIndex);
    if (!entry.useNextVaultAccountNonce) {
      const index = pureCircuits.requestIndex(entry);
      const hex = bytesToHex(index);
      if (takenRequestIndexes.has(hex) || state.outputRequestBuffer.member(index)) return;
      takenRequestIndexes.add(hex);
    }
    takenInIndexes.add(inIndex);
    inIndexes.push(inIndex);
  };
  first.requestIds.forEach(addAttestation);
  first.inIndexes.forEach(addRequest);
  for (const [requestId] of state.inputAttestationBuffer) addAttestation(requestId);
  for (const [inIndex] of state.inputRequestBuffer) addRequest(inIndex);
  return { inIndexes, requestIds };
}

/**
 * Flushes up to FLUSH_WIDTH waiting items, whoever queued them: `first` ahead of the
 * rest, then queued attestations, then queued requests, in ledger order. Requests that
 * would fail the flush (an identical caller-signed request is open) are left out, and
 * nothing is submitted when no item would move. The items are chosen from one ledger
 * read and the flush is built on a second, so another flush landing between them fails
 * the build with one of `flushQueue`'s own asserts. The
 * flush's ledger work runs in the transaction's fallible section, so a flush that loses
 * a race to another flush after it is built lands as a {@link CallTxFailedError} with
 * status `FailFallible` and still pays its fee.
 *
 * @param providers - The vault's provider set, whose wallet pays for the flush.
 * @param compiledContract - The vault's compiled contract.
 * @param vaultContractAddress - The vault's contract address.
 * @param first - Items to carry ahead of every other waiting item.
 * @returns How many slots the flush filled, 0 when it submitted nothing.
 * @throws {CallTxFailedError} When the flush lands but does not succeed entirely.
 * @throws {Error} With `flushQueue`'s assert message when another flush moved an
 *   item after it was chosen.
 */
export async function flushPending(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
  first: FlushItems = { inIndexes: [], requestIds: [] },
): Promise<number> {
  const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
  const { inIndexes, requestIds } = movableItems(state, first);
  if (inIndexes.length + requestIds.length === 0) return 0;
  await submitFlush(
    providers,
    compiledContract,
    vaultContractAddress,
    flushSlots(inIndexes, requestIds),
  );
  return requestIds.length + inIndexes.length;
}

// The asserts flushQueue trips on a slot whose item another flush has moved, or whose
// twin another flush has opened. The text must match the contract's assert messages.
const FLUSH_RACE_ASSERT =
  /^failed assert: (?:Request not queued|Identical request open|Attestation not queued)$/;

/**
 * Flushes, carrying `first` ahead of every other waiting item, until `flushed` holds for
 * the ledger. A flush that loses a race to another flush is retried, whether it landed
 * as `FailFallible` or failed to build on one of `flushQueue`'s own asserts.
 *
 * @param providers - The vault's provider set, whose wallet pays for the flushes.
 * @param compiledContract - The vault's compiled contract.
 * @param vaultContractAddress - The vault's contract address.
 * @param flushed - Whether the ledger shows what the caller waits for.
 * @param first - The items the caller waits for.
 * @param attempts - How many flushes to try.
 * @returns The ledger state that satisfied `flushed`.
 * @throws {Error} When no waiting item would move while `flushed` fails, on a failure
 *   other than a lost race, or when `flushed` still fails after the attempts.
 */
export async function flushUntil(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
  flushed: (state: VaultLedgerState) => boolean,
  first: FlushItems,
  attempts = 5,
): Promise<VaultLedgerState> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
    if (flushed(state)) return state;
    let carried: number;
    try {
      carried = await flushPending(providers, compiledContract, vaultContractAddress, first);
    } catch (error) {
      const lostRace =
        error instanceof CallTxFailedError
          ? error.finalizedTxData.status === FailFallible
          : error instanceof Error && FLUSH_RACE_ASSERT.test(error.message);
      if (!lostRace) throw error;
      console.log(`flush attempt ${String(attempt + 1)} lost a race to another flush`);
      continue;
    }
    if (carried === 0) {
      throw new Error(
        "nothing to flush: the awaited items are not queued, or each waits for an identical open request to settle",
      );
    }
  }
  const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
  if (flushed(state)) return state;
  throw new Error(`still not flushed after ${String(attempts)} flush attempts`);
}
