// `startApproveRouter` or `startApproveStata`, then `sendApprove`: queue the vault's
// approval of a contract-fixed spender, flush it, which assigns it the vault account's
// next EVM nonce, and record its SignBidirectionalEvent in the vault's
// bidirectionalApproveMap. It asks the MPC to sign an EVM `approve(spender,
// unlimitedAllowance())` on the ERC20, sent from the VAULT's derived address (path
// "vault"). The request id is recomputed off-chain with the library's TS twin of the
// request-id circuit and asserted against the ledger map index before it is returned.
// The settle side lives in complete-approve.ts.
import {
  bytesToHex,
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
  Action,
  type ApproveRequest,
  evmAddressBytes,
  flushedRequestIndex,
  newInputIndex,
  pureCircuits,
  readVaultLedger,
  VAULT_PATH_BYTES,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { logEvmFeeCap } from "../evm-logging.ts";
import { ERC20_APPROVE_SELECTOR } from "../evm-transfer.ts";
import { TRANSFER_RESULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { flushUntil } from "./vault-queue.ts";

/**
 * Read the vault ledger and refuse an uninitialised vault, whose starts reject.
 *
 * @param context - The flow context.
 * @returns The ledger state before the start.
 * @throws {Error} If the vault is not initialised.
 */
async function initialisedLedger(context: VaultContext): Promise<VaultLedgerState> {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!state.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  return state;
}

/**
 * Flush the approval queued under `inIndex`, send it with `sendApprove`, and
 * return its request id once the recomputed id is on the ledger.
 *
 * @param context - The flow context.
 * @param inIndex - The input index the approval was queued under.
 * @param before - The ledger state read before the start, for the pinned chain.
 * @param approval - The ERC20 and spender the start was called for.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If the recomputed request id does not appear on the ledger.
 */
async function flushAndSendApprove(
  context: VaultContext,
  inIndex: bigint,
  before: VaultLedgerState,
  approval: ApproveRequest,
): Promise<RequestIdHex> {
  const flushed = await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const outIndex = flushedRequestIndex(flushed, Action.approve, inIndex);
  const { evmNonce } = flushed.outputRequestBuffer.lookup(outIndex).entry;
  const { gas } = flushed.approveArgsMap.lookup(inIndex);
  console.log(`vault EVM nonce: ${String(evmNonce)}`);

  // The record the contract will store, reconstructed byte for byte: the event's
  // own sender (the vault contract, kernel.self() in-circuit), the pinned chain,
  // the nonce the flush assigned, the gas the start copied, the contract-built
  // `approve(spender, unlimitedAllowance())` calldata (the raw selector, the
  // ABI-ready big-endian spender and allowance words, as broadcast), the vault's
  // own 32-byte derivation path, and the contract-fixed routing.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...TRANSFER_RESULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: approval.erc20Address,
      chainId: before.evmChainId,
      nonce: evmNonce,
      gasLimit: gas.gasLimit,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_APPROVE_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(approval.spender),
            numericAbiWord(pureCircuits.unlimitedAllowance()),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));
  logEvmFeeCap(
    expectedIdHex,
    context.evmVaultAddress,
    expectedRecord.txParams.gasLimit,
    expectedRecord.txParams.maxFeePerGas,
    expectedRecord.txParams.maxPriorityFeePerGas,
  );

  const result = await context.vault.callTx.sendApprove(outIndex);
  console.log(`approval sent in tx ${result.public.txId}`);

  // The bidirectionalApproveMap index IS the record's transientHash digest:
  // recomputing it off-chain and finding it on the ledger proves both sides agree
  // on every byte of the event.
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalApproveMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's approve map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}

/** Options for {@link startApproveRouter}. */
export interface StartApproveRouterOptions {
  /** The ERC20 (20-byte 0x hex) the vault lets the Uniswap router spend. */
  readonly erc20Address: string;
}

/**
 * Queue the vault's approval of the pinned Uniswap router for one ERC20 with
 * `startApproveRouter` under a fresh input index, flush it, send it with
 * `sendApprove`, and return the resulting request id. A swap out of that ERC20
 * needs the approval on the EVM side first. The start is deployer-gated, so
 * this wallet's identity must be the deployer's, and only it can complete the
 * approval.
 *
 * @param context - The flow context.
 * @param options - The ERC20 to approve the router for.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If the vault is uninitialised, or the recomputed id does not
 *   appear on the ledger.
 */
export async function startApproveRouter(
  context: VaultContext,
  options: StartApproveRouterOptions,
): Promise<RequestIdHex> {
  const erc20 = evmAddressBytes(options.erc20Address);
  const before = await initialisedLedger(context);
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`erc20:          ${options.erc20Address}`);
  console.log(`spender:        0x${bytesToHex(before.uniswapRouter)} (Uniswap router)`);

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startApproveRouter(inIndex, erc20);
  console.log(`router approval queued in tx ${queued.public.txId}`);
  return flushAndSendApprove(context, inIndex, before, {
    erc20Address: erc20,
    spender: before.uniswapRouter,
  });
}

/**
 * Queue the vault's approval of the pinned stataToken wrapper to spend the
 * pinned underlying with `startApproveStata` under a fresh input index, flush
 * it, send it with `sendApprove`, and return the resulting request id. A
 * supply needs the approval on the EVM side first. The start is
 * deployer-gated, so this wallet's identity must be the deployer's, and only
 * it can complete the approval.
 *
 * @param context - The flow context.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If the vault is uninitialised, or the recomputed id does not
 *   appear on the ledger.
 */
export async function startApproveStata(context: VaultContext): Promise<RequestIdHex> {
  const before = await initialisedLedger(context);
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`erc20:          0x${bytesToHex(before.stataUnderlying)} (stata underlying)`);
  console.log(`spender:        0x${bytesToHex(before.stataToken)} (stataToken)`);

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startApproveStata(inIndex);
  console.log(`stata approval queued in tx ${queued.public.txId}`);
  return flushAndSendApprove(context, inIndex, before, {
    erc20Address: before.stataUnderlying,
    spender: before.stataToken,
  });
}
