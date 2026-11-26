// `startTronRedeem` then `sendTronRedeem`: surrender a shielded vault coin of the pinned
// Tron lend share token worth the shares plus its redeem fee (the contract burns it and
// mints the fee to the fee recipient), flush the queued redeem, and record its
// SignBidirectionalEvent in the vault's bidirectionalTronRedeemMap. It asks the MPC to sign
// a Tron `redeem(shares·factor, vault, vault)` on the pinned ERC-4626 share token from the
// VAULT's derived Tron account (path "vault") under the vault's redeem fee limit. The
// shares are in share coin units. The settle side lives in complete-tron-redeem.ts, and
// the refund of a redeem nobody sent in time in refund-unsent-tron-lend.ts.
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

import { STATA_REDEEM_SELECTOR } from "../evm-stata.ts";
import { TRON_REDEEM_MPC_ROUTING } from "../mpc-routing.ts";
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

/** Options for {@link queueTronRedeem}. */
export interface StartTronRedeemOptions extends TronWindowOptions {
  /** The shares to redeem, in the share token's coin units: the redeem burns shares·factor. */
  readonly shares: bigint;
}

/**
 * Queue a Tron redeem with `startTronRedeem` under a fresh input index and flush it. The
 * entry pins an ownership commitment of this wallet's identity secret, so only this caller
 * can complete the redeem and take its assets or its re-mint. The window is fresh unless
 * `options.window` names one.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The shares and window options
 * @returns The request id the send records, the flushed entry's index and the window
 * @throws {Error} If the shares are not positive, the vault is uninitialised or holds no
 *   Tron lend pair, or the caller's shielded balance cannot cover the shares plus the fee
 */
export async function queueTronRedeem(
  context: VaultContext,
  tron: TronContext,
  options: StartTronRedeemOptions,
): Promise<QueuedTronRequest> {
  if (options.shares <= 0n) {
    throw new Error(`shares must be a positive integer; got ${String(options.shares)}.`);
  }
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
  const share = vaultTronTokenConfig(state, state.tronLendShareToken);
  const fee = share.fees.redeem;
  const feeLimit = state.vaultTronFeeLimits.redeem;
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`underlying:        0x${bytesToHex(state.tronLendUnderlying)}`);
  console.log(`share token:       0x${bytesToHex(state.tronLendShareToken)}`);
  console.log(`redeem fee:        ${String(fee)} coin units`);
  console.log(`Tron fee limit:    ${String(feeLimit)} sun`);

  const window = await startTronTxWindow(tron, options);
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTronTokenType(share, context.vaultContractAddress)),
    value: options.shares + fee,
  };
  const inIndex = newInputIndex();
  const queued = await submitCallTx(context.providers, {
    ...createCallTxOptions(
      vaultCompiledContract,
      "startTronRedeem",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      feeRecipientEncryptionMapping(state),
      [inIndex, { shares: options.shares }, window, coin],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  console.log(`Tron redeem queued in tx ${queued.public.txId}`);
  const queuedState = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const outIndex = queuedRequestIndex(queuedState, inIndex);
  const stored = queuedState.tronRedeemArgsMap.lookup(inIndex);
  // The record `sendTronRedeem` stores: `redeem(shares·factor, vault, vault)` on the share
  // token plus the binding word, under the window and fee limit the start stored, all read
  // back from its args. The receiver and owner keep the assets in, and burn the shares from,
  // the vault's Tron account.
  const requestId = requestIdHex(
    calculateRequestId(
      tronVaultRequestRecord(context, TRON_REDEEM_MPC_ROUTING, {
        ...stored.tx,
        contractAddress: tronAddressFromEvm(state.tronLendShareToken),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: STATA_REDEEM_SELECTOR,
            noWords: 4n,
            words: [
              numericAbiWord(pureCircuits.tronBaseOfUnits(options.shares, share.factor)),
              evmAddressAbiWord(state.vaultEvmAddress),
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
 * Send a flushed Tron redeem with `sendTronRedeem`, which anyone may call, and check the
 * vault recorded the request id the start computed.
 *
 * @param context - The flow context
 * @param queued - The flushed redeem from {@link queueTronRedeem}
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault refuses the send (for example once the window is too close to
 *   closing) or the expected id is not on the ledger after it
 */
export async function sendTronRedeem(
  context: VaultContext,
  queued: QueuedTronRequest,
): Promise<RequestIdHex> {
  const result = await context.vault.callTx.sendTronRedeem(queued.outIndex);
  console.log(`Tron redeem sent in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronRedeemMap);
  if (!index.has(queued.requestId)) {
    throw new Error(
      `recomputed request id ${queued.requestId} not found in the vault's Tron redeem map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${queued.requestId}`);
  return queued.requestId;
}

/**
 * {@link queueTronRedeem} then {@link sendTronRedeem}.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The shares and window options
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} Whatever either step throws
 */
export async function startTronRedeem(
  context: VaultContext,
  tron: TronContext,
  options: StartTronRedeemOptions,
): Promise<RequestIdHex> {
  return sendTronRedeem(context, await queueTronRedeem(context, tron, options));
}
