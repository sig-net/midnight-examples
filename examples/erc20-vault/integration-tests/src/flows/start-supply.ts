// `startSupply`: surrender `amount` of the underlying (USDC) vault coin (burned) and QUEUE a
// stataToken.deposit(amount, vault) request; `flush` then records it on the vault's SUPPLY
// ledger map, to be signed with the VAULT's account and broadcast. Exact-input, so there is no
// change. The settle side lives in complete-supply.ts.
//
// The circuit no longer takes an EVM nonce: the shared vault EVM account's nonces come from
// the contract's own `vaultEvmNonce` counter at flush time. See ./flush.ts.
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
import { vaultTokenType } from "../vault-token.ts";
import { flushVaultRequests, vaultQueueKey } from "./flush.ts";

/** Options for {@link startSupply}. */
export interface StartSupplyOptions {
  readonly amount: bigint;
}

/**
 * Queue the supply request (stataToken.deposit(amount, vault)), flush it, and return the id
 * the flush minted. The burned coin is the underlying (USDC) vault token of exactly `amount`.
 *
 * @param context - The flow context.
 * @param options - The supply parameters (amount).
 * @returns The recorded supply request id.
 */
export async function startSupply(
  context: VaultContext,
  options: StartSupplyOptions,
): Promise<RequestIdHex> {
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

  // The record the contract composes: vault path/sender, stataToken `to`, contract-fixed gas,
  // deposit(amount, receiver=vault).
  const result = await context.vault.callTx.startSupply(
    SIGNET_DEFAULT_KEY_VERSION,
    options.amount,
    coin,
  );
  console.log(`supply queued in tx ${result.public.txId}`);

  // Both nonces are read BETWEEN the queue and the drain, because both are the
  // contract's to assign: this flush drains one entry in slot 0, so it is handed
  // exactly these values.
  const beforeFlush = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: beforeFlush.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SUPPLY_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: before.stataToken,
      chainId: before.evmChainId,
      nonce: beforeFlush.vaultEvmNonce,
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

  await flushVaultRequests(context, [vaultQueueKey(context, coin.nonce)]);

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
  return expectedIdHex;
}
