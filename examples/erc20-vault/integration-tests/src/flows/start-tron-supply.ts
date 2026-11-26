// `startTronSupply` then `sendTronSupply`: surrender a shielded vault coin of the pinned
// Tron lend underlying worth the amount plus its supply fee (the contract burns it and
// mints the fee to the fee recipient), flush the queued supply, and record its
// SignBidirectionalEvent in the vault's bidirectionalTronSupplyMap. It asks the MPC to sign
// a Tron `deposit(amount·factor, vault)` on the pinned ERC-4626 share token from the
// VAULT's derived Tron account (path "vault") under the vault's supply fee limit. The
// amount is in underlying coin units and at least `tronLendMinSupply`. The settle side
// lives in complete-tron-supply.ts, and the refund of a supply nobody sent in time in
// refund-unsent-tron-lend.ts.
import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import {
  bytesToHex,
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

import { STATA_DEPOSIT_SELECTOR } from "../evm-stata.ts";
import { TRON_SUPPLY_MPC_ROUTING } from "../mpc-routing.ts";
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

/** Options for {@link queueTronSupply}. */
export interface StartTronSupplyOptions extends TronWindowOptions {
  /** Supply amount in the underlying's coin units: the deposit moves amount·factor base units. */
  readonly amount: bigint;
}

/**
 * Queue a Tron supply with `startTronSupply` under a fresh input index and flush it. The
 * entry pins an ownership commitment of this wallet's identity secret, so only this caller
 * can complete the supply and take its shares or its re-mint. The window is fresh unless
 * `options.window` names one.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The supply amount and window options
 * @returns The request id the send records, the flushed entry's index and the window
 * @throws {Error} If the amount is below the vault's minimum supply, the vault is
 *   uninitialised or holds no Tron lend pair, or the caller's shielded balance cannot cover
 *   the amount plus the fee
 */
export async function queueTronSupply(
  context: VaultContext,
  tron: TronContext,
  options: StartTronSupplyOptions,
): Promise<QueuedTronRequest> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  if (state.tronLendShareToken.every((byte) => byte === 0)) {
    throw new Error("the vault holds no Tron lend pair: run `yarn set-tron-lend-pair:erc20-vault`");
  }
  if (options.amount < state.tronLendMinSupply) {
    throw new Error(
      `amount ${String(options.amount)} is below the vault's minimum supply ` +
        `${String(state.tronLendMinSupply)} underlying coin units`,
    );
  }
  const underlying = vaultTronTokenConfig(state, state.tronLendUnderlying);
  const fee = underlying.fees.supply;
  const feeLimit = state.vaultTronFeeLimits.supply;
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`underlying:        0x${bytesToHex(state.tronLendUnderlying)}`);
  console.log(`share token:       0x${bytesToHex(state.tronLendShareToken)}`);
  console.log(`supply fee:        ${String(fee)} coin units`);
  console.log(`Tron fee limit:    ${String(feeLimit)} sun`);

  const window = await startTronTxWindow(tron, options);
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTronTokenType(underlying, context.vaultContractAddress)),
    value: options.amount + fee,
  };
  const inIndex = newInputIndex();
  const queued = await submitCallTx(context.providers, {
    ...createCallTxOptions(
      vaultCompiledContract,
      "startTronSupply",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      feeRecipientEncryptionMapping(state),
      [inIndex, { amount: options.amount }, window, coin],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  console.log(`Tron supply queued in tx ${queued.public.txId}`);
  const queuedState = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const outIndex = queuedRequestIndex(queuedState, inIndex);
  const stored = queuedState.tronSupplyArgsMap.lookup(inIndex);
  // The record `sendTronSupply` stores: `deposit(amount·factor, vault)` on the share token
  // plus the binding word, under the window and fee limit the start stored, all read back from
  // its args. The receiver keeps the shares in the vault's Tron account.
  const requestId = requestIdHex(
    calculateRequestId(
      tronVaultRequestRecord(context, TRON_SUPPLY_MPC_ROUTING, {
        ...stored.tx,
        contractAddress: tronAddressFromEvm(state.tronLendShareToken),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: STATA_DEPOSIT_SELECTOR,
            noWords: 3n,
            words: [
              numericAbiWord(pureCircuits.tronBaseOfUnits(options.amount, underlying.factor)),
              evmAddressAbiWord(state.vaultEvmAddress),
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
 * Send a flushed Tron supply with `sendTronSupply`, which anyone may call, and check the
 * vault recorded the request id the start computed.
 *
 * @param context - The flow context
 * @param queued - The flushed supply from {@link queueTronSupply}
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault refuses the send (for example once the window is too close to
 *   closing) or the expected id is not on the ledger after it
 */
export async function sendTronSupply(
  context: VaultContext,
  queued: QueuedTronRequest,
): Promise<RequestIdHex> {
  const result = await context.vault.callTx.sendTronSupply(queued.outIndex);
  console.log(`Tron supply sent in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronSupplyMap);
  if (!index.has(queued.requestId)) {
    throw new Error(
      `recomputed request id ${queued.requestId} not found in the vault's Tron supply map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${queued.requestId}`);
  return queued.requestId;
}

/**
 * {@link queueTronSupply} then {@link sendTronSupply}.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The supply amount and window options
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} Whatever either step throws
 */
export async function startTronSupply(
  context: VaultContext,
  tron: TronContext,
  options: StartTronSupplyOptions,
): Promise<RequestIdHex> {
  return sendTronSupply(context, await queueTronSupply(context, tron, options));
}
