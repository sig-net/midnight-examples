// `startRedeem`: surrender `shares` of the stataUSDC vault coin (burned) and QUEUE a
// stataToken.redeem(shares, vault, vault) request; `flush` then records it on the vault's
// REDEEM ledger map, to be signed with the VAULT's account and broadcast. The settle side
// lives in complete-redeem.ts.
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
  readVaultLedger,
  STATA_USDC,
  VAULT_PATH_BYTES,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { REDEEM_MPC_ROUTING, STATA_REDEEM_SELECTOR } from "../evm-stata.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTokenType } from "../vault-token.ts";
import { FlushKind, flushVaultRequests, vaultQueueKey } from "./flush.ts";

/** Options for {@link startRedeem}. */
export interface StartRedeemOptions {
  readonly shares: bigint;
}

/**
 * Queue the redeem request (stataToken.redeem(shares, vault, vault)), flush it, and return the
 * id the flush minted. The burned coin is the stataUSDC vault token of exactly `shares`.
 *
 * @param context - The flow context.
 * @param options - The redeem parameters (shares).
 * @returns The recorded redeem request id.
 */
export async function startRedeem(
  context: VaultContext,
  options: StartRedeemOptions,
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
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "redeem");

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(STATA_USDC, context.vaultContractAddress)),
    value: options.shares,
  };

  const result = await context.vault.callTx.startRedeem(
    SIGNET_DEFAULT_KEY_VERSION,
    options.shares,
    coin,
  );
  console.log(`redeem queued in tx ${result.public.txId}`);

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
    ...REDEEM_MPC_ROUTING,
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
          selector: STATA_REDEEM_SELECTOR,
          noWords: 3n,
          words: [
            numericAbiWord(options.shares),
            evmAddressAbiWord(before.vaultEvmAddress),
            evmAddressAbiWord(before.vaultEvmAddress),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  await flushVaultRequests(context, FlushKind.Redeems, [vaultQueueKey(context, coin.nonce)]);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.redeemEventMap).has(expectedIdHex)) {
    throw new Error(
      `recomputed redeem request id ${expectedIdHex} not found on the redeem ledger map`,
    );
  }
  console.log(`redeem request id: ${expectedIdHex}`);
  return expectedIdHex;
}
