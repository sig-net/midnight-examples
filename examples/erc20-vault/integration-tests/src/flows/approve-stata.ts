// `approveStata`: record an approve(stataToken, ~unlimited) SignBidirectionalEvent on the
// vault's ledger (field 0), have the MPC sign it with the VAULT's account, and broadcast it.
// Sign-only (nothing minted, no settle circuit), so the round trip ends at the broadcast. The
// approve is called ON the pinned underlying (USDC), spender = the pinned stataToken wrapper,
// so the wrapper can pull USDC during supply.
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
  AAVE_USDC,
  evmAddressBytes,
  pureCircuits,
  readVaultLedger,
  STATA_USDC,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { type ContractReadMethod, logSkip } from "@sig-net/midnight-examples-test-harness";

import { logEvmFeeCap } from "../evm-logging.ts";
import { APPROVE_SELECTOR, MAX_APPROVE } from "../evm-stata.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { assignedNonce, flushUntilStamped, queueKey } from "./vault-queue.ts";

/**
 * Queues an approve(stataToken) request on the underlying and returns its queue key.
 *
 * @param context - The vault context.
 * @returns The queue key the flush and send take.
 * @throws {Error} When the vault is not initialised.
 */
export async function queueApproveStata(context: VaultContext): Promise<Uint8Array> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised)
    throw new Error("vault is not initialised, run the initialise flow first");
  const key = pureCircuits.approveStataBinder();
  const queued = await context.vault.callTx.approveStata();
  console.log(`approveStata queued in tx ${queued.public.txId}`);
  return key;
}

/**
 * Sends a flushed approve(stataToken) request to the singleton and returns its request id.
 *
 * @param context - The vault context.
 * @param key - The queue key of the flushed request.
 * @returns The request id recorded on the vault ledger.
 * @throws {Error} When the recomputed request id is not on the ledger.
 */
export async function sendApproveStata(
  context: VaultContext,
  key: Uint8Array,
): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "approve");

  // approve(stataToken, MAX) on the underlying USDC, signed with the vault account (path
  // "vault"), the same 2-word map + bool schema as a transfer.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: evmAddressBytes(AAVE_USDC),
      chainId: before.evmChainId,
      nonce: await assignedNonce(context, key),
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: APPROVE_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(evmAddressBytes(STATA_USDC)), numericAbiWord(MAX_APPROVE)],
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
  const result = await context.vault.callTx.sendApproveStata(key);
  console.log(`approveStata sent in tx ${result.public.txId}`);
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed approve request id ${expectedIdHex} not found on the ledger`);
  }
  return expectedIdHex;
}

/**
 * Queues, flushes and sends an approve(stataToken) request.
 *
 * @param context - The vault context.
 * @returns The request id recorded on the vault ledger.
 */
export async function approveStata(context: VaultContext): Promise<RequestIdHex> {
  const key = await queueApproveStata(context);
  await flushUntilStamped(context, key);
  return sendApproveStata(context, key);
}

/**
 * Approves the stataToken wrapper from the vault account unless an allowance already exists.
 *
 * @param session - The vault session.
 */
export async function ensureStataApproved(session: VaultSession): Promise<void> {
  const context = await session.vaultContext();
  const { ethers } = await import("ethers");
  const token = new ethers.Contract(
    AAVE_USDC,
    ["function allowance(address,address) view returns (uint256)"],
    new ethers.JsonRpcProvider(context.evmRpcUrl),
  );
  const allowance: bigint = await token.getFunction<ContractReadMethod<bigint>>("allowance")(
    context.evmVaultAddress,
    STATA_USDC,
  );
  if (allowance > 0n) {
    logSkip("approveStata", `stataToken already approved (allowance ${String(allowance)})`);
    return;
  }

  const requestId = await approveStata(context);
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
  });
  await broadcastEvm(context, { transaction: signed });
  console.log("stataToken approved to pull the underlying");
}
