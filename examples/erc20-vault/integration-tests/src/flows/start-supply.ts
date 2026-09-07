// `startSupply`: both phases of the supply request. Phase 1 (`requestSupply`) surrenders
// `amount` of the underlying (USDC) vault coin (burned) and parks the amount in the vault's
// EVM nonce allocator. Phase 2 (`assignSupply`) proves the allocator slot the request key
// landed in and records a stataToken.deposit(amount, vault) SignBidirectionalEvent on the
// vault's SUPPLY ledger map, to be signed with the VAULT's account at the EVM nonce that slot
// owns and broadcast. Exact-input, so there is no change. The settle side lives in
// complete-supply.ts.
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
  AAVE_USDC,
  readVaultLedger,
  VAULT_PATH_BYTES,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { STATA_DEPOSIT_SELECTOR, SUPPLY_MPC_ROUTING } from "../evm-stata.ts";
import type { VaultContext } from "../vault-context.ts";
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { vaultTokenType } from "../vault-token.ts";

/** Options for {@link startSupply}. */
export interface StartSupplyOptions {
  readonly amount: bigint;
}

/** What {@link startSupply} hands back: the recorded request, plus what settling it needs. */
export interface StartedSupply {
  /** The recorded supply request id. */
  readonly requestId: RequestIdHex;
  /**
   * The surrendered coin's nonce — the value the request was keyed on. The
   * settle-view `commitment` is `requestCommitment(secret, coinNonce)`, so
   * `completeSupply` / `refundSupply` take this back as their `commitmentNonce`.
   */
  readonly coinNonce: Uint8Array;
}

/**
 * Record the supply request (stataToken.deposit(amount, vault)) and return its id. The burned
 * coin is the underlying (USDC) vault token of exactly `amount`.
 *
 * Two phases: `requestSupply` burns the coin and parks the amount under
 * `requestCommitment(secret, coin.nonce)`, then `assignSupply` presents the Merkle path
 * proving where that key landed in `slots`, which is what fixes the EVM tx nonce
 * (`evmNonceBase + slotIndex`) and the event's request nonce (the slot index). Neither phase
 * takes a caller-supplied EVM nonce, so the expected record can only be rebuilt once phase 1
 * has applied and the slot is known.
 *
 * @param context - The flow context.
 * @param options - The supply parameters (amount).
 * @returns The recorded supply request id and the surrendered coin's nonce.
 */
export async function startSupply(
  context: VaultContext,
  options: StartSupplyOptions,
): Promise<StartedSupply> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised)
    throw new Error("vault is not initialised, run the initialise flow first");

  // The gas envelope the circuit itself will stamp, read from the ledger the
  // deployer's setGasParams writes. Read, never mirrored as a constant: the
  // envelope is hashed into the request id, so a stale copy recomputes the
  // wrong id the moment the cap is raised.
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "supply");

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(AAVE_USDC, context.vaultContractAddress)),
    value: options.amount,
  };

  // Phase 1: burn and park. No request id exists yet.
  const requested = await context.vault.callTx.requestSupply(
    SIGNET_DEFAULT_KEY_VERSION,
    options.amount,
    coin,
  );
  console.log(`requestSupply finalized in tx ${requested.public.txId}`);

  const key = vaultRequestKey(context, coin.nonce);
  const slot = await resolveRequestSlot(context, key);
  console.log(
    `supply allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`,
  );

  // The record the contract composes: vault path/sender, the slot's request and EVM nonces,
  // stataToken `to`, contract-fixed gas, deposit(amount, receiver=vault).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: slot.index,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SUPPLY_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: before.stataToken,
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
          selector: STATA_DEPOSIT_SELECTOR,
          noWords: 2n,
          words: [numericAbiWord(options.amount), evmAddressAbiWord(before.vaultEvmAddress)],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignSupply(key, slot.path);
  console.log(`assignSupply finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.supplyEventMap).has(expectedIdHex)) {
    throw new Error(
      `recomputed supply request id ${expectedIdHex} not found on the supply ledger map`,
    );
  }
  console.log(`supply request id: ${expectedIdHex}`);
  return { requestId: expectedIdHex, coinNonce: coin.nonce };
}
