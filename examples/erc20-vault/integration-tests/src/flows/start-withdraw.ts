// `startWithdraw`: the first half of the withdraw flow. Surrender a shielded
// vault coin (burned by the contract) so the vault will later `transfer` the
// ERC20 to a destination from its OWN derived EVM address (path = "vault").
//
// Two steps now, not one. `startWithdraw` (the circuit) only validates, burns
// and QUEUES: it mints no request id, records no event and notifies nobody, so
// it reads no shared ledger cell and two callers' withdrawals no longer
// conflict at apply time. `flush` — permissionless, batched — mints the id,
// assigns BOTH nonces (the request-id nonce and the shared vault EVM account's
// transaction nonce) and records the event. The id is therefore only knowable
// after the flush, and this module's {@link startWithdraw} does both halves and
// returns it. Callers that need to batch (two requesters, ONE flush) use
// {@link queueWithdraw} + {@link flushVaultRequests} +
// {@link predictWithdrawRequestId} directly.

import {
  calculateRequestId,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import {
  evmAddressBytes,
  readVaultLedger,
  VAULT_PATH_BYTES,
  vaultGasEnvelope,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { ERC20_TRANSFER_SELECTOR } from "../evm-transfer.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTokenType } from "../vault-token.ts";
import { flushVaultRequests, vaultQueueKey } from "./flush.ts";

/** Options for {@link startWithdraw} and {@link queueWithdraw}. */
export interface StartWithdrawOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
}

/**
 * A withdrawal sitting in the contract's queue: everything needed to flush it
 * and to recompute the request id the flush will mint. There is deliberately
 * no EVM nonce here — the vault EVM account's nonce belongs to the contract's
 * `vaultEvmNonce` counter and is only assigned at flush time.
 */
export interface QueuedWithdraw {
  /** The `pendingVaultRequests` key `flush` drains it by. */
  readonly queueKey: Uint8Array;
  /** Nonce of the surrendered coin: the queue key's binder and the settle view's. */
  readonly coinNonce: Uint8Array;
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** The ERC20 being withdrawn, as 20 raw bytes. */
  readonly erc20: Uint8Array;
  /** The EVM recipient, as 20 raw bytes. */
  readonly destEvmAddress: Uint8Array;
}

/**
 * Call the vault's `startWithdraw` circuit: burn a shielded vault coin of
 * exactly `options.amount` and queue the withdrawal. No request id exists yet.
 *
 * The coin's color comes from the compiled `vaultTokenDomainSeparator` circuit
 * plus the runtime's `rawTokenType`, and midnight-js funds its value from the
 * caller's shielded balance when it balances the call. The circuit pins a
 * refund COMMITMENT of this wallet's identity secret (never a public key)
 * bound to the surrendered coin's nonce — which is also the queue key — so
 * only this caller can pull a refund once `flush` copies it into the settle
 * view.
 *
 * @param context - The flow context.
 * @param options - The withdraw arguments.
 * @returns The queued entry, for {@link flushVaultRequests}.
 * @throws {Error} If an option is invalid, the vault is uninitialised, or the
 *   caller's shielded balance cannot cover `options.amount`.
 */
export async function queueWithdraw(
  context: VaultContext,
  options: StartWithdrawOptions,
): Promise<QueuedWithdraw> {
  if (options.amount <= 0n) {
    throw new Error(`amount must be a positive integer; got ${String(options.amount)}.`);
  }
  const destEvmAddress = evmAddressBytes(options.destEvmAddress);
  const erc20 = evmAddressBytes(context.erc20Address);
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`erc20:          ${context.erc20Address}`);
  console.log(`destination:    ${options.destEvmAddress}`);
  console.log(`amount:         ${String(options.amount)}`);

  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }

  // The surrendered coin: the vault token for THIS erc20, of exactly
  // `amount`, under a fresh random nonce.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amount,
  };

  const result = await context.vault.callTx.startWithdraw(
    SIGNET_DEFAULT_KEY_VERSION,
    { erc20Address: erc20, amount: options.amount, destEvmAddress },
    coin,
  );
  console.log(`withdraw queued in tx ${result.public.txId}`);

  return {
    queueKey: vaultQueueKey(context, coin.nonce),
    coinNonce: coin.nonce,
    amount: options.amount,
    erc20,
    destEvmAddress,
  };
}

/**
 * The SignBidirectionalEvent `flush` records for a queued withdrawal,
 * reconstructed byte for byte off-chain: the event's own sender (the vault
 * contract, `kernel.self()` in-circuit), the fully contract-composed envelope
 * (the pinned chain, the contract-fixed gas), the contract-built
 * `transfer(destination, amount)` calldata (the raw selector, the ABI-ready
 * big-endian address and amount words, as broadcast), the vault's own 32-byte
 * derivation path, and the contract-fixed routing.
 *
 * Both nonces are arguments because both are the CONTRACT's to assign: slot i
 * of a batch gets request nonce `signetRequestNonce + i`, and the i-th entry a
 * batch actually drains gets EVM nonce `vaultEvmNonce + i` (skipped slots
 * consume nothing — the EVM nonce sequence must have no gaps).
 *
 * @param context - The flow context.
 * @param state - The vault ledger state read BEFORE the flush.
 * @param queued - The queued withdrawal.
 * @param requestNonce - The request-id nonce the flush assigns this entry.
 * @param evmNonce - The vault EVM account nonce the flush assigns this entry.
 * @returns The expected record.
 */
export function withdrawRequestRecord(
  context: VaultContext,
  state: VaultLedgerState,
  queued: QueuedWithdraw,
  requestNonce: bigint,
  evmNonce: bigint,
): SignBidirectionalEvent {
  // The gas envelope the circuit itself will stamp, read from the ledger the
  // deployer's setGasParams writes. Read, never mirrored as a constant: the
  // envelope is hashed into the request id, so a stale copy recomputes the
  // wrong id the moment the cap is raised.
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(state, "withdraw");
  return {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: state.caip2Id,
    txParams: {
      to: queued.erc20,
      chainId: state.evmChainId,
      nonce: evmNonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(queued.destEvmAddress), numericAbiWord(queued.amount)],
        },
      },
    },
  };
}

/**
 * The request id {@link withdrawRequestRecord}'s record hashes to, computed
 * with the library's TS twin of the request-id circuit.
 *
 * @param context - The flow context.
 * @param state - The vault ledger state read BEFORE the flush.
 * @param queued - The queued withdrawal.
 * @param requestNonce - The request-id nonce the flush assigns this entry.
 * @param evmNonce - The vault EVM account nonce the flush assigns this entry.
 * @returns The request id as 64-char lowercase hex.
 */
export function predictWithdrawRequestId(
  context: VaultContext,
  state: VaultLedgerState,
  queued: QueuedWithdraw,
  requestNonce: bigint,
  evmNonce: bigint,
): RequestIdHex {
  return requestIdHex(
    calculateRequestId(withdrawRequestRecord(context, state, queued, requestNonce, evmNonce)),
  );
}

/**
 * Queue a withdrawal and immediately flush it, returning the request id the
 * flush minted.
 *
 * The id is recomputed off-chain from the two counters read just before the
 * flush and asserted present as a ledger map key afterwards: the map key IS
 * the record's transientHash digest, so finding it there proves both sides
 * agree on every byte of the event — including the EVM nonce the contract,
 * not the caller, chose.
 *
 * @param context - The flow context.
 * @param options - The withdraw arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If an option is invalid, the vault is uninitialised, the caller's
 *   shielded balance cannot cover `options.amount`, or the recomputed id
 *   does not appear on the ledger.
 */
export async function startWithdraw(
  context: VaultContext,
  options: StartWithdrawOptions,
): Promise<RequestIdHex> {
  const queued = await queueWithdraw(context, options);

  // Read the two counters between the queue and the drain: this call flushes a
  // single entry in slot 0, so it is handed exactly these values.
  const beforeFlush = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const expectedIdHex = predictWithdrawRequestId(
    context,
    beforeFlush,
    queued,
    beforeFlush.signetRequestNonce,
    beforeFlush.vaultEvmNonce,
  );

  await flushVaultRequests(context, [queued.queueKey]);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.signBidirectionalEventMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found on the ledger — ` +
        `present ids: [${[...index.keys()].join(", ")}] (was another request flushed concurrently?)`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}
