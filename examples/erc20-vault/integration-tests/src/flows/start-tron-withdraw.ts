// `startTronWithdraw` then `sendTronWithdraw`: surrender a shielded vault coin of a
// TRC-20 worth the amount plus the withdraw fee, flush the queued withdrawal, and record
// its SignBidirectionalEvent in the vault's bidirectionalTronWithdrawMap. It asks the MPC
// to sign a Tron `transfer(destination, amount)` on the TRC-20 from the VAULT's derived
// Tron account (path "vault") under the vault's fee limit. Tron has no nonce: the
// transaction names a solidified reference block and expires, so the withdrawer picks the
// window, and a transaction that never lands is attested unviable and refunded. The
// settle side lives in complete-tron-withdraw.ts, and the refund of a withdrawal nobody
// sent in time in refund-unsent-tron-withdraw.ts.
import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import {
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
  type TronTriggerSmartContractTxParams,
  TxParamType,
} from "@sig-net/midnight";
import {
  feeRecipientEncryptionMapping,
  newInputIndex,
  queuedRequestIndex,
  readVaultLedger,
  VAULT_PATH_BYTES,
  VAULT_PRIVATE_STATE_ID,
  type VaultLedgerState,
  vaultTronTokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import { ERC20_TRANSFER_SELECTOR } from "../evm-transfer.ts";
import { TRON_TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTronTokenType } from "../vault-token.ts";
import { flushUntil } from "./vault-queue.ts";

/** The validity window a withdrawal asks for by default: one hour from its timestamp. */
export const TRON_WITHDRAW_WINDOW_MS = 3_600_000n;

/** The withdrawer's TaPoS reference and validity window, in Tron's milliseconds. */
export interface TronTxWindow {
  readonly refBlockBytes: Uint8Array;
  readonly refBlockHash: Uint8Array;
  readonly timestamp: bigint;
  readonly expiration: bigint;
}

/** Options for {@link queueTronWithdraw}. */
export interface StartTronWithdrawOptions {
  /** Withdraw amount in the TRC-20's base units. */
  readonly amount: bigint;
  /** The recipient's 21-byte, 0x41-prefixed Tron address. */
  readonly destTronAddress: Uint8Array;
  /** The TRC-20, as 20 EVM-form bytes. Defaults to the context's TRC-20. */
  readonly tokenAddress?: Uint8Array;
  /** The window, counted from the timestamp. Defaults to {@link TRON_WITHDRAW_WINDOW_MS}. */
  readonly windowMs?: bigint;
  /** Exact reference and window fields, used verbatim instead of a fresh window. */
  readonly window?: TronTxWindow;
}

/** A started and flushed Tron withdrawal, ready for {@link sendTronWithdraw}. */
export interface QueuedTronWithdraw {
  /** The request id the send records, computed off-chain from the start's arguments. */
  readonly requestId: RequestIdHex;
  /** The input index the start queued it under, which a refund names. */
  readonly inIndex: bigint;
  readonly outIndex: Uint8Array;
  readonly window: TronTxWindow;
}

// The record `sendTronWithdraw` stores for these arguments: the vault's own path, the
// Tron routing, the vault's fee limit, and `transfer(destination, amount)` on the token.
function expectedTronWithdrawRecord(
  context: VaultContext,
  state: VaultLedgerState,
  tokenAddress: Uint8Array,
  options: StartTronWithdrawOptions,
  window: TronTxWindow,
): SignBidirectionalEvent<TronTriggerSmartContractTxParams> {
  return {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...TRON_TRANSFER_RESULT_MPC_ROUTING,
    txParamType: TxParamType.tronTriggerSmartContract,
    txParams: {
      ...window,
      feeLimit: state.vaultTronFeeLimit,
      contractAddress: tronAddressFromEvm(tokenAddress),
      callValue: 0n,
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(options.destTronAddress.subarray(1)),
            numericAbiWord(options.amount),
          ],
        },
      },
    },
  };
}

/**
 * Queue a Tron withdrawal with `startTronWithdraw` under a fresh input index and flush it.
 * The window is fresh unless `options.window` names one: a timestamp of now on the
 * solidified head, which cannot be reorganised away, expiring `windowMs` later. The vault
 * does not refuse the fields of an earlier Tron withdrawal, which name a transaction Tron
 * takes only once, so an `options.window` must not repeat an earlier withdrawal's.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The withdraw arguments
 * @returns The request id the send records, the flushed entry's index and the window
 * @throws {Error} If an option is invalid, the vault is uninitialised or does not allow the
 *   TRC-20, or the caller's shielded balance cannot cover the amount plus the fee
 */
export async function queueTronWithdraw(
  context: VaultContext,
  tron: TronContext,
  options: StartTronWithdrawOptions,
): Promise<QueuedTronWithdraw> {
  if (options.amount <= 0n) {
    throw new Error(`amount must be a positive integer; got ${String(options.amount)}.`);
  }
  if (options.destTronAddress.length !== 21 || options.destTronAddress[0] !== 0x41) {
    throw new Error("destTronAddress must be 21 bytes with the 0x41 prefix");
  }
  const tokenAddress = options.tokenAddress ?? tron.trc20Address;
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  const fee = vaultTronTokenFees(state, tokenAddress).withdraw;
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`withdraw fee:      ${String(fee)} base units`);
  console.log(`Tron fee limit:    ${String(state.vaultTronFeeLimit)} sun`);

  let window = options.window;
  if (window === undefined) {
    const reference = await getSolidifiedTronReferenceBlock(tron.tronRpcUrl);
    const timestamp = BigInt(Date.now());
    window = {
      refBlockBytes: reference.refBlockBytes,
      refBlockHash: reference.refBlockHash,
      timestamp,
      expiration: timestamp + (options.windowMs ?? TRON_WITHDRAW_WINDOW_MS),
    };
  }
  const requestId = requestIdHex(
    calculateRequestId(expectedTronWithdrawRecord(context, state, tokenAddress, options, window)),
  );

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTronTokenType(tokenAddress, context.vaultContractAddress)),
    value: options.amount + fee,
  };
  const inIndex = newInputIndex();
  const queued = await submitCallTx(context.providers, {
    ...createCallTxOptions(
      vaultCompiledContract,
      "startTronWithdraw",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      feeRecipientEncryptionMapping(state),
      [
        inIndex,
        {
          tokenAddress,
          amount: options.amount,
          destTronAddress: options.destTronAddress.subarray(1),
        },
        window,
        coin,
      ],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  console.log(`Tron withdraw queued in tx ${queued.public.txId}`);
  const outIndex = queuedRequestIndex(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    inIndex,
  );
  await flushUntil(context, (flushed) => !flushed.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  return { requestId, inIndex, outIndex, window };
}

/**
 * Send a flushed Tron withdrawal with `sendTronWithdraw`, which anyone may call, and check
 * the vault recorded the request id the start computed.
 *
 * @param context - The flow context
 * @param queued - The flushed withdrawal from {@link queueTronWithdraw}
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault refuses the send (for example once the window is too close to
 *   closing) or the expected id is not on the ledger after it
 */
export async function sendTronWithdraw(
  context: VaultContext,
  queued: QueuedTronWithdraw,
): Promise<RequestIdHex> {
  const result = await context.vault.callTx.sendTronWithdraw(queued.outIndex);
  console.log(`Tron withdraw sent in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronWithdrawMap);
  if (!index.has(queued.requestId)) {
    throw new Error(
      `recomputed request id ${queued.requestId} not found in the vault's Tron withdraw map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${queued.requestId}`);
  return queued.requestId;
}

/**
 * {@link queueTronWithdraw} then {@link sendTronWithdraw}.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The withdraw arguments
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} Whatever either step throws
 */
export async function startTronWithdraw(
  context: VaultContext,
  tron: TronContext,
  options: StartTronWithdrawOptions,
): Promise<RequestIdHex> {
  return sendTronWithdraw(context, await queueTronWithdraw(context, tron, options));
}
