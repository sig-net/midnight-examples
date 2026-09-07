// `startSwap`: surrender amountInMaximum of the tokenIn vault coin (burned) and QUEUE an
// exactOutputSingle request; `flush` then records it on the vault's SWAP ledger map, to be
// signed with the VAULT's account and broadcast. The settle side lives in complete-swap.ts.
//
// The circuit no longer takes an EVM nonce: all four vault-signed flows sign from ONE shared
// vault EVM account, so the contract's own `vaultEvmNonce` counter hands out that account's
// nonces at flush time. See ./flush.ts and start-withdraw.ts.
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

import { EXACT_OUTPUT_SINGLE_SELECTOR, SWAP_MPC_ROUTING } from "../evm-swap.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTokenType } from "../vault-token.ts";
import { FlushKind, flushVaultRequests, vaultQueueKey } from "./flush.ts";

/** Options for {@link startSwap}. */
export interface StartSwapOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly amountInMaximum: bigint;
}

/**
 * Queue the swap request (exactOutputSingle), flush it, and return the id the flush minted.
 * tokenIn = context.erc20Address.
 *
 * @param context - The flow context.
 * @param options - The swap parameters (tokenOut, fee, amountOut, amountInMaximum).
 * @returns The recorded swap request id.
 */
export async function startSwap(
  context: VaultContext,
  options: StartSwapOptions,
): Promise<RequestIdHex> {
  const tokenIn = evmAddressBytes(context.erc20Address);
  const tokenOut = evmAddressBytes(options.tokenOut);
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
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "swap");

  // Surrender the tokenIn vault coin of exactly amountInMaximum (burned; completeSwap returns
  // the unspent remainder as change).
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amountInMaximum,
  };

  const result = await context.vault.callTx.startSwap(
    SIGNET_DEFAULT_KEY_VERSION,
    {
      tokenIn,
      tokenOut,
      fee: options.fee,
      amountOut: options.amountOut,
      amountInMaximum: options.amountInMaximum,
    },
    coin,
  );
  console.log(`swap queued in tx ${result.public.txId}`);

  // Both nonces are read BETWEEN the queue and the drain, because both are the
  // contract's to assign: this flush drains one entry in slot 0, so it is handed
  // exactly these values.
  const beforeFlush = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  // The record the contract composes: vault path/sender, router `to`, contract-fixed gas,
  // exactOutputSingle((tokenIn, tokenOut, fee, recipient=vault, amountOut, amountInMaximum, 0)).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: beforeFlush.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SWAP_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: before.uniswapRouter,
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
          selector: EXACT_OUTPUT_SINGLE_SELECTOR,
          noWords: 7n,
          words: [
            evmAddressAbiWord(tokenIn),
            evmAddressAbiWord(tokenOut),
            numericAbiWord(options.fee),
            evmAddressAbiWord(before.vaultEvmAddress),
            numericAbiWord(options.amountOut),
            numericAbiWord(options.amountInMaximum),
            numericAbiWord(0n),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  await flushVaultRequests(context, FlushKind.Swaps, [vaultQueueKey(context, coin.nonce)]);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.swapEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed swap request id ${expectedIdHex} not found on the swap ledger map`);
  }
  console.log(`swap request id:   ${expectedIdHex}`);
  return expectedIdHex;
}
