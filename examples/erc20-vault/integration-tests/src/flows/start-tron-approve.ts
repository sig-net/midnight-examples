import {
  bytesToHex,
  calculateRequestId,
  evmAddressAbiWord,
  getSolidifiedTronReferenceBlock,
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
  newInputIndex,
  pureCircuits,
  queuedRequestIndex,
  readVaultLedger,
  VAULT_PATH_BYTES,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { ERC20_APPROVE_SELECTOR } from "../evm-transfer.ts";
import { TRON_TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import type { TronTxWindow } from "./start-tron-withdraw.ts";
import { flushUntil } from "./vault-queue.ts";

/** */
export const VAULT_TRON_WINDOW_MS = 3_600_000n;

/**
 * @param tron - The Tron context
 * @param windowMs - How long after now the transaction expires
 * @returns The fields of a vault-signed Tron transaction the caller chooses: the solidified
 *   head block reference, the current time as its timestamp, and its expiration
 */
export async function newVaultTronTx(tron: TronContext, windowMs: bigint): Promise<TronTxWindow> {
  const reference = await getSolidifiedTronReferenceBlock(tron.tronRpcUrl);
  const timestamp = BigInt(Date.now());
  return {
    refBlockBytes: reference.refBlockBytes,
    refBlockHash: reference.refBlockHash,
    timestamp,
    expiration: timestamp + windowMs,
  };
}

/** */
export interface StartTronApproveRouterOptions {
  readonly tokenAddress: Uint8Array;
}

/**
 * @param context - The flow context, of the deployer's wallet
 * @param tron - The Tron context
 * @param options - The TRC-20 to approve the SunSwap router for
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault is not initialised or the recomputed id is not on the ledger
 */
export async function startTronApproveRouter(
  context: VaultContext,
  tron: TronContext,
  options: StartTronApproveRouterOptions,
): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`Tron owner:        ${tron.tronVaultAddress.base58}`);
  console.log(`spender:           0x${bytesToHex(before.sunswapRouter)} (SunSwap router)`);

  const tronTx = await newVaultTronTx(tron, VAULT_TRON_WINDOW_MS);
  const expectedRecord: SignBidirectionalEvent<TronTxParams> = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...TRON_TRANSFER_RESULT_MPC_ROUTING,
    txParamType: TxParamType.tron,
    txParams: {
      ...tronTx,
      feeLimit: before.vaultTronFeeLimits.approve,
      contractAddress: tronAddressFromEvm(options.tokenAddress),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_APPROVE_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(before.sunswapRouter),
            numericAbiWord(pureCircuits.unlimitedAllowance()),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startTronApproveRouter(
    inIndex,
    tronTx,
    options.tokenAddress,
  );
  console.log(`Tron router approval queued in tx ${queued.public.txId}`);
  const outIndex = queuedRequestIndex(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    inIndex,
  );
  await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const result = await context.vault.callTx.sendTronApprove(outIndex);
  console.log(`Tron router approval sent in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronApproveMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's Tron approve map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}
