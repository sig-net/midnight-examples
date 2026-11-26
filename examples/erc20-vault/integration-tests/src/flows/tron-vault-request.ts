// What every Tron request the vault's own account signs shares on the client side: the
// window the requester picks (a solidified reference block, a timestamp of now, an
// expiration a window later), the record the send stores (the vault's own path, the Tron
// routing, the action's fee limit copied at start), and the moment from which the action's
// refundUnsent circuit takes back a request nobody sent in time, and the coin units an
// attested supply or redeem mints. Tron has no nonce: a withdrawal, supply or redeem names
// its own transaction through the binding word its start stores (the ownership commitment of
// a fresh input index), and an approve, which carries none, through a fresh timestamp.
import {
  bytesToBigint,
  getSolidifiedTronReferenceBlock,
  hexToBytes,
  type RequestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  type TronTriggerSmartContractTxParams,
  TxParamType,
} from "@sig-net/midnight";
import { pureCircuits, VAULT_PATH_BYTES } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultMpcRouting } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";

/** The validity window a vault-signed Tron request asks for by default: one hour. */
export const TRON_REQUEST_WINDOW_MS = 3_600_000n;

/** The requester's TaPoS reference and validity window, in Tron's milliseconds. */
export interface TronTxWindow {
  readonly refBlockBytes: Uint8Array;
  readonly refBlockHash: Uint8Array;
  readonly timestamp: bigint;
  readonly expiration: bigint;
}

/** A started and flushed vault-signed Tron request, ready for its action's send. */
export interface QueuedTronRequest {
  /** The request id the send records, computed off-chain from the args the start stored. */
  readonly requestId: RequestIdHex;
  /** The input index the start queued it under, which a refund names. */
  readonly inIndex: bigint;
  /** The flushed entry's index, which the send names. */
  readonly outIndex: Uint8Array;
  readonly window: TronTxWindow;
}

/** The window options every vault-signed Tron start takes. */
export interface TronWindowOptions {
  /** The window, counted from the timestamp. Defaults to {@link TRON_REQUEST_WINDOW_MS}. */
  readonly windowMs?: bigint;
  /** Exact reference and window fields, used verbatim instead of a fresh window. */
  readonly window?: TronTxWindow;
}

/**
 * A fresh window on the solidified head, which cannot be reorganised away: a timestamp of
 * now, expiring `windowMs` later.
 *
 * @param tron - The Tron context whose node serves the solidified head
 * @param windowMs - The window, counted from the timestamp
 * @returns The window
 * @throws {Error} If the node does not answer
 */
async function freshTronTxWindow(tron: TronContext, windowMs: bigint): Promise<TronTxWindow> {
  const reference = await getSolidifiedTronReferenceBlock(tron.tronRpcUrl);
  const timestamp = BigInt(Date.now());
  return {
    refBlockBytes: reference.refBlockBytes,
    refBlockHash: reference.refBlockHash,
    timestamp,
    expiration: timestamp + windowMs,
  };
}

/**
 * The window a start uses: `options.window` verbatim, else a fresh one. The vault does not
 * refuse the fields of an earlier request, which name a transaction Tron takes only once: an
 * approve's `options.window` must not repeat an earlier approve's (the binding word of a
 * withdrawal, supply or redeem already makes its transaction its own).
 *
 * @param tron - The Tron context whose node serves the solidified head
 * @param options - The start's window options
 * @returns The window
 * @throws {Error} If a fresh window is needed and the node does not answer
 */
export async function startTronTxWindow(
  tron: TronContext,
  options: TronWindowOptions,
): Promise<TronTxWindow> {
  return options.window ?? freshTronTxWindow(tron, options.windowMs ?? TRON_REQUEST_WINDOW_MS);
}

/**
 * The record a vault-signed Tron send stores: the vault contract as sender, the vault's
 * own path, the action's routing and the transaction its args fix.
 *
 * @param context - The flow context
 * @param routing - The action's MPC routing, carrying its output schema
 * @param txParams - The transaction: the window, the fee limit the start copied, the
 *   contract called and its calldata
 * @returns The record, whose `calculateRequestId` is the id the send records
 */
export function tronVaultRequestRecord(
  context: VaultContext,
  routing: VaultMpcRouting,
  txParams: TronTriggerSmartContractTxParams,
): SignBidirectionalEvent<TronTriggerSmartContractTxParams> {
  return {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...routing,
    txParamType: TxParamType.tronTriggerSmartContract,
    txParams,
  };
}

/**
 * The first time, in milliseconds, at which the vault refunds an unsent Tron request
 * expiring at `expiration`: the first block time at which the action's send refuses it,
 * h - tronSendMinRemainingSeconds(), h the expiration's whole seconds.
 *
 * @param expiration - The request's expiration, in Tron's milliseconds
 * @returns The opening time in milliseconds since the epoch, on a whole second
 */
export function tronRefundOpensAtMs(expiration: bigint): bigint {
  return (expiration / 1000n - pureCircuits.tronSendMinRemainingSeconds()) * 1000n;
}

/**
 * Sleep until the vault refunds an unsent Tron request expiring at `expiration`.
 *
 * @param expiration - The request's expiration, in Tron's milliseconds
 */
export async function waitForTronRefund(expiration: bigint): Promise<void> {
  const opensAt = tronRefundOpensAtMs(expiration);
  const waitMs = Number(opensAt - BigInt(Date.now()));
  if (waitMs <= 0) return;
  console.log(`refund opens at ${new Date(Number(opensAt)).toISOString()}, waiting`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/**
 * The coin units an executed Tron supply or redeem mints: the attested uint256 (32 bytes,
 * little-endian) floored to coin units by the contract's `tronUnitsOfBaseFloor`, given the
 * quotient the `unitsOfBase` witness computes.
 *
 * @param serializedOutput - The attested output bytes
 * @param factor - The minted token's factor
 * @returns The coin units the complete circuit mints
 * @throws {Error} If the value reaches 2^128 or its quotient Uint<64>, which the complete
 *   circuit refuses too
 */
export function tronAttestedUnits(serializedOutput: Uint8Array, factor: bigint): bigint {
  const base = bytesToBigint(serializedOutput);
  return pureCircuits.tronUnitsOfBaseFloor(base, factor, base / factor);
}
