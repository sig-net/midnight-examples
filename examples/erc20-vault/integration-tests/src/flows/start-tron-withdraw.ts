// `startTronWithdraw` then `sendTronWithdraw`: surrender a shielded vault coin of a
// TRC-20 worth the amount plus the withdraw fee, flush the queued withdrawal, and record
// its SignBidirectionalEvent in the vault's bidirectionalTronWithdrawMap. It asks the MPC
// to sign a Tron `transfer(destination, amount·factor)` on the TRC-20 from the VAULT's
// derived Tron account (path "vault") under the vault's withdraw fee limit. Tron has no nonce: the
// transaction names a solidified reference block and expires, so the withdrawer picks the
// window, and a transaction that never lands is attested unviable and refunded. The
// settle side lives in complete-tron-withdraw.ts, and the refund of a withdrawal nobody
// sent in time in refund-unsent-tron-withdraw.ts.
import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import {
  calculateRequestId,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  type RequestIdHex,
  requestIdHex,
  toSignBidirectionalEventIndex,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import {
  feeRecipientEncryptionMapping,
  newInputIndex,
  pureCircuits,
  queuedRequestIndex,
  readVaultLedger,
  VAULT_PRIVATE_STATE_ID,
  vaultTronTokenConfig,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import { ERC20_TRANSFER_SELECTOR } from "../evm-transfer.ts";
import { TRON_TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTronTokenType } from "../vault-token.ts";
import {
  type QueuedTronRequest,
  startTronTxWindow,
  tronVaultRequestRecord,
  type TronWindowOptions,
} from "./tron-vault-request.ts";
import { flushUntil } from "./vault-queue.ts";

/** Options for {@link queueTronWithdraw}. */
export interface StartTronWithdrawOptions extends TronWindowOptions {
  /** Withdraw amount in the TRC-20's coin units: the transfer moves amount·factor base units. */
  readonly amount: bigint;
  /** The recipient's 21-byte, 0x41-prefixed Tron address. */
  readonly destTronAddress: Uint8Array;
  /** The TRC-20, as 20 EVM-form bytes. Defaults to the context's TRC-20. */
  readonly tokenAddress?: Uint8Array;
}

/**
 * Queue a Tron withdrawal with `startTronWithdraw` under a fresh input index and flush it.
 * The window is fresh unless `options.window` names one: a timestamp of now on the
 * solidified head, which cannot be reorganised away, expiring `windowMs` later. The start's
 * binding word (its ownership commitment) makes the transfer this request's own, so the
 * fresh input index is what keeps it from repeating an earlier Tron transaction.
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
): Promise<QueuedTronRequest> {
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
  const config = vaultTronTokenConfig(state, tokenAddress);
  const fee = config.fees.withdraw;
  const feeLimit = state.vaultTronFeeLimits.withdraw;
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`withdraw fee:      ${String(fee)} coin units`);
  console.log(`token factor:      ${String(config.factor)} base units per coin unit`);
  console.log(`Tron fee limit:    ${String(feeLimit)} sun`);

  const window = await startTronTxWindow(tron, options);
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTronTokenType(config, context.vaultContractAddress)),
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
  const queuedState = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const outIndex = queuedRequestIndex(queuedState, inIndex);
  const stored = queuedState.tronWithdrawArgsMap.lookup(inIndex);
  // The record `sendTronWithdraw` stores: `transfer(destination, amount·factor)` on the
  // token plus the binding word, under the window and fee limit the start stored, all read
  // back from its args.
  const requestId = requestIdHex(
    calculateRequestId(
      tronVaultRequestRecord(context, TRON_TRANSFER_RESULT_MPC_ROUTING, {
        ...stored.tx,
        contractAddress: tronAddressFromEvm(tokenAddress),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: ERC20_TRANSFER_SELECTOR,
            noWords: 3n,
            words: [
              evmAddressAbiWord(options.destTronAddress.subarray(1)),
              numericAbiWord(pureCircuits.tronBaseOfUnits(options.amount, config.factor)),
              stored.binding,
            ],
          },
        },
      }),
    ),
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
  queued: QueuedTronRequest,
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
