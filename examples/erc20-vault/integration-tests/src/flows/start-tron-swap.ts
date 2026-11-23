import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
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
  tronAddressFromEvm,
  type TronTxParams,
  TxParamType,
} from "@sig-net/midnight";
import {
  feeRecipientEncryptionMapping,
  newInputIndex,
  queuedRequestIndex,
  readVaultLedger,
  VAULT_PATH_BYTES,
  VAULT_PRIVATE_STATE_ID,
  vaultTronTokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import { SWAP_MPC_ROUTING, TRON_TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTronTokenType } from "../vault-token.ts";
import { newVaultTronTx, VAULT_TRON_WINDOW_MS } from "./start-tron-approve.ts";
import { flushUntil } from "./vault-queue.ts";

/** */
export const SUNSWAP_EXACT_OUTPUT_SINGLE_SELECTOR = Uint8Array.of(0xdb, 0x3e, 0x21, 0x98);

const TRON_INT64_MAX = 2n ** 63n - 1n;

/** */
export interface StartTronSwapOptions {
  readonly tokenAddressIn: Uint8Array;
  readonly tokenAddressOut: Uint8Array;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly amountInMaximum: bigint;
  readonly windowMs?: bigint;
}

/** */
export interface QueuedTronSwap {
  readonly inIndex: bigint;
  readonly outIndex: Uint8Array;
  readonly requestId: RequestIdHex;
}

/**
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The swap arguments
 * @returns The queued swap's indexes and the request id its send will record
 * @throws {Error} If the vault is not initialised or does not allow the sold TRC-20
 */
export async function queueTronSwap(
  context: VaultContext,
  tron: TronContext,
  options: StartTronSwapOptions,
): Promise<QueuedTronSwap> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`Tron owner:        ${tron.tronVaultAddress.base58}`);

  const swapFee = vaultTronTokenFees(before, options.tokenAddressIn).swap;
  console.log(`swap fee:          ${String(swapFee)} base units`);
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTronTokenType(options.tokenAddressIn, context.vaultContractAddress)),
    value: options.amountInMaximum + swapFee,
  };

  const tronTx = await newVaultTronTx(tron, options.windowMs ?? VAULT_TRON_WINDOW_MS);
  const expectedRecord: SignBidirectionalEvent<TronTxParams> = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SWAP_MPC_ROUTING,
    executionDest: TRON_TRANSFER_RESULT_MPC_ROUTING.executionDest,
    txParamType: TxParamType.tron,
    txParams: {
      ...tronTx,
      feeLimit: before.vaultTronFeeLimits.swap,
      contractAddress: tronAddressFromEvm(before.sunswapRouter),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: SUNSWAP_EXACT_OUTPUT_SINGLE_SELECTOR,
          noWords: 8n,
          words: [
            evmAddressAbiWord(options.tokenAddressIn),
            evmAddressAbiWord(options.tokenAddressOut),
            numericAbiWord(options.fee),
            evmAddressAbiWord(before.vaultEvmAddress),
            numericAbiWord(TRON_INT64_MAX),
            numericAbiWord(options.amountOut),
            numericAbiWord(options.amountInMaximum),
            numericAbiWord(0n),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const inIndex = newInputIndex();
  const queued = await submitCallTx(context.providers, {
    ...createCallTxOptions(
      vaultCompiledContract,
      "startTronSwap",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      feeRecipientEncryptionMapping(before),
      [
        inIndex,
        tronTx,
        {
          tokenAddressIn: options.tokenAddressIn,
          tokenAddressOut: options.tokenAddressOut,
          fee: options.fee,
          amountOut: options.amountOut,
          amountInMaximum: options.amountInMaximum,
        },
        coin,
      ],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  console.log(`Tron swap queued in tx ${queued.public.txId}`);
  const outIndex = queuedRequestIndex(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    inIndex,
  );
  return { inIndex, outIndex, requestId: expectedIdHex };
}

/**
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The swap arguments
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault is not initialised, does not allow the sold TRC-20, or the
 *   recomputed id is not on the ledger
 */
export async function startTronSwap(
  context: VaultContext,
  tron: TronContext,
  options: StartTronSwapOptions,
): Promise<RequestIdHex> {
  const {
    inIndex,
    outIndex,
    requestId: expectedIdHex,
  } = await queueTronSwap(context, tron, options);
  await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const result = await context.vault.callTx.sendTronSwap(outIndex);
  console.log(`Tron swap sent in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronSwapMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's Tron swap map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}
