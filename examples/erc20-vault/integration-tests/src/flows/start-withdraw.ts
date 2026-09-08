// The withdraw request, both phases. Phase 1 (`requestWithdraw`) surrenders a
// shielded vault coin (burned by the contract) and parks the withdraw
// parameters in the vault's EVM nonce allocator under this caller's request
// key. Phase 2 (`assignWithdraw`) proves which allocator slot the key landed
// in and records the SignBidirectionalEvent asking the MPC to sign an EVM
// `transfer(destination, amount)` on the ERC20, sent from the VAULT's derived
// address (path = "vault") at the EVM nonce that slot owns. The request id is
// recomputed off-chain with the library's TS twin of the request-id circuit
// and asserted against the ledger map key before it is returned.

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
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { ERC20_TRANSFER_SELECTOR } from "../evm-transfer.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { vaultTokenType } from "../vault-token.ts";

/** Options for {@link startWithdraw}. */
export interface StartWithdrawOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
}

/** What {@link startWithdraw} hands back: the recorded request, plus what settling it needs. */
export interface StartedWithdraw {
  /** The recorded request id as 64-char lowercase hex. */
  readonly requestId: RequestIdHex;
  /**
   * The surrendered coin's nonce — the value the request was keyed on. The
   * settle-view `commitment` on the ledger is `requestCommitment(secret,
   * coinNonce)`, so `completeWithdraw` / `refundWithdraw` take this back as
   * their `commitmentNonce` argument to prove the caller is the withdrawer.
   */
  readonly coinNonce: Uint8Array;
}

/**
 * Run both phases of the vault's withdraw request on the deployed contract
 * and return the resulting request id.
 *
 * Phase 1 surrenders a shielded vault coin of exactly `amount` — the coin's
 * color comes from the compiled `vaultTokenDomainSeparator` circuit plus the
 * runtime's `rawTokenType`, and midnight-js funds its value from the caller's
 * shielded balance when it balances the call. The coin's NONCE is what keys
 * the request: a coin is spendable once, so the allocator leaf
 * `requestCommitment(secret, coinNonce)` cannot collide. That key is also the
 * refund gate — a commitment over this wallet's identity secret, never a
 * public key — so only this caller can pull a refund if the EVM transfer
 * fails, and the nonce is returned here so a later settle can prove it.
 *
 * Phase 2 re-reads the ledger, builds the Merkle path proving where the key
 * landed in `slots`, and calls `assignWithdraw`, which derives the EVM tx
 * nonce (`evmNonceBase + slotIndex`) and the event's request nonce (the slot
 * index) from the path alone. Neither phase takes a caller-supplied EVM
 * nonce: the pooled vault account's nonces are the allocator's to hand out.
 * The vault pays the withdraw gas, so the whole fee envelope is
 * contract-fixed too (mirrored here by the `ERC20_TRANSFER_*` constants —
 * keep in lockstep). The expected request record is reconstructed off-chain
 * once the slot is known, its id computed with the library's
 * `calculateRequestId` TS twin, and asserted present as a ledger map key
 * after the call.
 *
 * @param context - The flow context.
 * @param options - The withdraw arguments.
 * @returns The request id and the surrendered coin's nonce.
 * @throws {Error} If an option is invalid, the vault is uninitialised, the caller's
 *   shielded balance cannot cover `options.amount`, the parked key cannot be
 *   found in the allocator, or the recomputed id does not appear on the ledger.
 */
export async function startWithdraw(
  context: VaultContext,
  options: StartWithdrawOptions,
): Promise<StartedWithdraw> {
  if (options.amount <= 0n) {
    throw new Error(`amount must be a positive integer; got ${String(options.amount)}.`);
  }
  const destEvmAddress = evmAddressBytes(options.destEvmAddress);
  const erc20 = evmAddressBytes(context.erc20Address);
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`erc20:          ${context.erc20Address}`);
  console.log(`destination:    ${options.destEvmAddress}`);
  console.log(`amount:         ${String(options.amount)}`);

  // Pre-call ledger read: the pinned chain config, which initialise writes
  // once and nothing rewrites.
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }

  // The gas envelope the circuit itself will stamp, read from the ledger the
  // deployer's setGasParams writes. Read, never mirrored as a constant: the
  // envelope is hashed into the request id, so a stale copy recomputes the
  // wrong id the moment the cap is raised.
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "withdraw");

  // The surrendered coin: the vault token for THIS erc20, of exactly
  // `amount`, under a fresh random nonce.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amount,
  };

  const keyVersion = SIGNET_DEFAULT_KEY_VERSION;

  // Phase 1: burn the coin and park the parameters. Nothing is recorded for
  // the MPC yet, and no request id exists yet — the slot that decides it is
  // allocated when this transaction applies.
  const requested = await context.vault.callTx.requestWithdraw(
    keyVersion,
    {
      erc20Address: erc20,
      amount: options.amount,
      destEvmAddress,
    },
    coin,
  );
  console.log(`requestWithdraw finalized in tx ${requested.public.txId}`);

  // Which slot phase 1 landed in, read back from the allocator tree.
  const key = vaultRequestKey(context, coin.nonce);
  const slot = await resolveRequestSlot(context, key);
  console.log(`allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`);

  // The record the contract will store, reconstructed byte for byte: the
  // event's own sender (the vault contract, kernel.self() in-circuit), the
  // EVM nonce the slot proves, the fully contract-composed
  // envelope (the pinned chain, the contract-fixed gas), the contract-built
  // `transfer(destination, amount)` calldata (the raw selector, the ABI-ready
  // big-endian address and amount words, as broadcast), the vault's own
  // 32-byte derivation path, and the contract-fixed routing.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    // A constant, for every VAULT-signed flow: the EVM nonce inside txParams is
    // already unique per request (one vault account, one nonce each), so the
    // circuit hashes a 0 here rather than a second copy of that uniqueness.
    requestNonce: 0n,
    keyVersion,
    path: VAULT_PATH_BYTES,
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce: slot.evmNonce,
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
          words: [evmAddressAbiWord(destEvmAddress), numericAbiWord(options.amount)],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignWithdraw(key, slot.path);
  console.log(`assignWithdraw finalized in tx ${result.public.txId}`);

  // The ledger map key IS the record's transientHash digest: recomputing it
  // off-chain and finding it on the ledger proves both sides agree on every
  // byte of the event.
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.signBidirectionalEventMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found on the ledger — ` +
        `present ids: [${[...index.keys()].join(", ")}] (was another request submitted concurrently?)`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return { requestId: expectedIdHex, coinNonce: coin.nonce };
}
