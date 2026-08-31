// `startSwap`: record an exactOutputSingle SignBidirectionalEvent on the vault's SWAP ledger
// map, surrendering amountInMaximum of the tokenIn vault coin (burned), to be signed with the
// VAULT's account and broadcast. The settle side lives in complete-swap.ts.
import {
  asciiPadded,
  calculateRequestId,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  PATH_BYTES,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";

import {
  EXACT_OUTPUT_SINGLE_SELECTOR,
  SWAP_GAS_LIMIT,
  SWAP_MAX_FEE_PER_GAS,
  SWAP_MAX_PRIORITY_FEE_PER_GAS,
  SWAP_MPC_ROUTING,
  UNISWAP_SWAP_ROUTER_02,
} from "../evm-swap.ts";
import { evmAddressBytes } from "../evm-transfer.ts";
import type { VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import { vaultTokenType } from "../vault-token.ts";

const VAULT_PATH = asciiPadded("vault", PATH_BYTES);

/** Options for {@link startSwap}. */
export interface StartSwapOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly amountInMaximum: bigint;
  readonly evmNonce: bigint;
}

/**
 * Record the swap request (exactOutputSingle) and return its id. tokenIn = context.erc20Address.
 *
 * @param context - The flow context.
 * @param options - The swap parameters (tokenOut, fee, amountOut, amountInMaximum, evmNonce).
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

  // Surrender the tokenIn vault coin of exactly amountInMaximum (burned; completeSwap returns
  // the unspent remainder as change).
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amountInMaximum,
  };

  // The record the contract composes: vault path/sender, router `to`, contract-fixed gas,
  // exactOutputSingle((tokenIn, tokenOut, fee, recipient=vault, amountOut, amountInMaximum, 0)).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH,
    ...SWAP_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: evmAddressBytes(UNISWAP_SWAP_ROUTER_02),
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit: SWAP_GAS_LIMIT,
      maxFeePerGas: SWAP_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: SWAP_MAX_PRIORITY_FEE_PER_GAS,
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
            evmAddressAbiWord(evmAddressBytes(context.evmVaultAddress)),
            numericAbiWord(options.amountOut),
            numericAbiWord(options.amountInMaximum),
            numericAbiWord(0n),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.startSwap(
    options.evmNonce,
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
  console.log(`swap finalized in tx ${result.public.txId}`);

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
