import {
  calculateRequestId,
  evmAddressAbiWord,
  getSolidifiedTronReferenceBlock,
  hexToBytes,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  pureCircuits as signetCircuits,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  tronAddressFromEvm,
  type TronTriggerSmartContractTxParams,
  TxParamType,
} from "@sig-net/midnight";
import {
  newInputIndex,
  pureCircuits,
  queuedRequestIndex,
  readVaultLedger,
  vaultTronTokenConfig,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { ERC20_TRANSFER_SELECTOR } from "../evm-transfer.ts";
import type { TronContext } from "../tron-context.ts";
import { getTrc20Balance } from "../tron-http.ts";
import type { VaultContext } from "../vault-context.ts";
import { flushUntil } from "./vault-queue.ts";

/** */
export const TRON_DEPOSIT_WINDOW_MS = 3_600_000n;

/** */
export const TRON_DEPOSIT_FEE_LIMIT = 100_000_000n;

/** */
export interface StartTronDepositOptions {
  /** Deposit amount in the TRC-20's coin units: the transfer moves amount·factor base units. */
  readonly amount: bigint;
  readonly tokenAddress?: Uint8Array;
  readonly windowMs?: bigint;
  readonly allowUnfunded?: boolean;
}

/**
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The deposit arguments
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If an option is invalid
 */
export async function startTronDeposit(
  context: VaultContext,
  tron: TronContext,
  options: StartTronDepositOptions,
): Promise<RequestIdHex> {
  if (options.amount <= 0n) {
    throw new Error(`amount must be a positive integer; got ${String(options.amount)}.`);
  }
  const tokenAddress = options.tokenAddress ?? tron.trc20Address;
  const token = tronAddressFromEvm(tokenAddress);
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`Tron owner:        ${tron.tronUserAddress.base58}`);

  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  const baseAmount = pureCircuits.tronBaseOfUnits(
    options.amount,
    vaultTronTokenConfig(before, tokenAddress).factor,
  );

  if (options.allowUnfunded !== true) {
    const balance = await getTrc20Balance(tron.tronRpcUrl, token, tron.tronUserAddress.bytes);
    if (balance < baseAmount) {
      throw new Error(
        `${tron.tronUserAddress.base58} holds ${String(balance)} base units of the TRC-20, less ` +
          `than the deposit's ${String(baseAmount)}: fund it on Tron and rerun`,
      );
    }
  }

  const reference = await getSolidifiedTronReferenceBlock(tron.tronRpcUrl);
  const timestamp = BigInt(Date.now());
  const tronTx = {
    refBlockBytes: reference.refBlockBytes,
    refBlockHash: reference.refBlockHash,
    timestamp,
    expiration: timestamp + (options.windowMs ?? TRON_DEPOSIT_WINDOW_MS),
    feeLimit: TRON_DEPOSIT_FEE_LIMIT,
  };

  const expectedRecord: SignBidirectionalEvent<TronTriggerSmartContractTxParams> = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: context.identity.commitment,
    algo: MPCSignatureAlgorithm.ecdsa,
    signatureDest: MPCDestination.unused,
    params: new Uint8Array(MPC_PARAMS_BYTES),
    executionDest: signetCircuits.tronCaip2Id(),
    outputDeserializationSchema: new Uint8Array(0),
    respondSerializationSchema: new Uint8Array(0),
    txParamType: TxParamType.tronTriggerSmartContract,
    txParams: {
      ...tronTx,
      contractAddress: token,
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(before.vaultEvmAddress), numericAbiWord(baseAmount)],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startTronDeposit(inIndex, tronTx, {
    tokenAddress,
    amount: options.amount,
  });
  console.log(`Tron deposit queued in tx ${queued.public.txId}`);
  const outIndex = queuedRequestIndex(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    inIndex,
  );
  await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const result = await context.vault.callTx.sendTronDeposit(outIndex);
  console.log(`Tron deposit sent in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronDepositMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's Tron deposit map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}
