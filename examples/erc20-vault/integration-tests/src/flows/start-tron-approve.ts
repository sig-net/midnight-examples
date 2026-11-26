// `startTronApprove` then `sendTronApprove`: queue the vault's approval of the pinned Tron
// lend share token, flush it, and record its SignBidirectionalEvent in the vault's
// bidirectionalTronApproveMap. It asks the MPC to sign a Tron `approve(shareToken,
// unlimitedAllowance())` on the pinned underlying from the VAULT's derived Tron account
// (path "vault") under the vault's approve fee limit, which a Tron supply needs. The
// deployer picks the window, and an approval nobody sent in it surrendered nothing: the
// deployer starts another. The settle side lives in complete-tron-approve.ts.
import {
  bytesToHex,
  calculateRequestId,
  evmAddressAbiWord,
  numericAbiWord,
  type RequestIdHex,
  requestIdHex,
  toSignBidirectionalEventIndex,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import {
  newInputIndex,
  pureCircuits,
  queuedRequestIndex,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { ERC20_APPROVE_SELECTOR } from "../evm-transfer.ts";
import { TRON_TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  type QueuedTronRequest,
  startTronTxWindow,
  tronVaultRequestRecord,
  type TronWindowOptions,
} from "./tron-vault-request.ts";
import { flushUntil } from "./vault-queue.ts";

/**
 * Queue the vault's Tron approval with `startTronApprove` under a fresh input index and
 * flush it. The start is deployer-gated, so this wallet's identity must be the deployer's,
 * and only it can complete the approval. The window is fresh unless `options.window`
 * names one.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The window options
 * @returns The request id the send records, the flushed entry's index and the window
 * @throws {Error} If the vault is uninitialised, holds no Tron lend pair, or the circuit
 *   rejects the caller or the window
 */
export async function queueTronApprove(
  context: VaultContext,
  tron: TronContext,
  options: TronWindowOptions,
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
  const feeLimit = state.vaultTronFeeLimits.approve;
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(
    `TRC-20:            0x${bytesToHex(state.tronLendUnderlying)} (Tron lend underlying)`,
  );
  console.log(
    `spender:           0x${bytesToHex(state.tronLendShareToken)} (Tron lend share token)`,
  );
  console.log(`Tron fee limit:    ${String(feeLimit)} sun`);

  const window = await startTronTxWindow(tron, options);
  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startTronApprove(inIndex, window);
  console.log(`Tron approve queued in tx ${queued.public.txId}`);
  const queuedState = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const outIndex = queuedRequestIndex(queuedState, inIndex);
  const stored = queuedState.tronApproveArgsMap.lookup(inIndex);
  // The record `sendTronApprove` stores: `approve(shareToken, unlimitedAllowance())` on the
  // underlying under the window and fee limit the start stored, read back from its args.
  const requestId = requestIdHex(
    calculateRequestId(
      tronVaultRequestRecord(context, TRON_TRANSFER_RESULT_MPC_ROUTING, {
        ...stored.tx,
        contractAddress: tronAddressFromEvm(state.tronLendUnderlying),
        callValue: 0n,
        calldata: {
          is_some: true,
          value: {
            selector: ERC20_APPROVE_SELECTOR,
            noWords: 2n,
            words: [
              evmAddressAbiWord(state.tronLendShareToken),
              numericAbiWord(pureCircuits.unlimitedAllowance()),
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
 * Send a flushed Tron approval with `sendTronApprove`, which anyone may call, and check the
 * vault recorded the request id the start computed.
 *
 * @param context - The flow context
 * @param queued - The flushed approval from {@link queueTronApprove}
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} If the vault refuses the send (for example once the window is too close to
 *   closing) or the expected id is not on the ledger after it
 */
export async function sendTronApprove(
  context: VaultContext,
  queued: QueuedTronRequest,
): Promise<RequestIdHex> {
  const result = await context.vault.callTx.sendTronApprove(queued.outIndex);
  console.log(`Tron approve sent in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalTronApproveMap);
  if (!index.has(queued.requestId)) {
    throw new Error(
      `recomputed request id ${queued.requestId} not found in the vault's Tron approve map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:        ${queued.requestId}`);
  return queued.requestId;
}

/**
 * {@link queueTronApprove} then {@link sendTronApprove}.
 *
 * @param context - The flow context
 * @param tron - The Tron context
 * @param options - The window options
 * @returns The request id as 64-char lowercase hex
 * @throws {Error} Whatever either step throws
 */
export async function startTronApprove(
  context: VaultContext,
  tron: TronContext,
  options: TronWindowOptions,
): Promise<RequestIdHex> {
  return sendTronApprove(context, await queueTronApprove(context, tron, options));
}
