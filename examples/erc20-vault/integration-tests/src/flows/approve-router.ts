// `approveRouter`: record an approve(uniswapRouter, ~unlimited) SignBidirectionalEvent on
// the vault's ledger (field 0, a 2-word call like transfer), have the MPC sign it with the
// VAULT's account, and broadcast it. Sign-only: nothing is minted and there is no settle
// circuit, so the round trip ends at the broadcast. One-time per token; the allowance is
// global (one pooled account), so the first caller readies a token for everyone.
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
  evmAddressBytes,
  pureCircuits,
  readVaultLedger,
  UNISWAP_SWAP_ROUTER_02,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { type ContractReadMethod, logSkip } from "@sig-net/midnight-examples-test-harness";

import { logEvmFeeCap } from "../evm-logging.ts";
import { APPROVE_SELECTOR, MAX_APPROVE } from "../evm-swap.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { assignedNonce, flushUntilStamped, queueKey } from "./vault-queue.ts";

/**
 * Queues an approve(router) request for an ERC20 and returns its queue key.
 *
 * @param context - The vault context.
 * @param erc20Address - The ERC20 to approve, the context's by default.
 * @returns The queue key the flush and send take.
 * @throws {Error} When the vault is not initialised.
 */
export async function queueApproveRouter(
  context: VaultContext,
  erc20Address: string = context.erc20Address,
): Promise<Uint8Array> {
  const erc20 = evmAddressBytes(erc20Address);
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised)
    throw new Error("vault is not initialised, run the initialise flow first");
  const key = pureCircuits.approveRouterBinder(erc20);
  const queued = await context.vault.callTx.approveRouter(erc20);
  console.log(`approveRouter queued in tx ${queued.public.txId}`);
  return key;
}

/**
 * Sends a flushed approve(router) request to the singleton and returns its request id.
 *
 * @param context - The vault context.
 * @param key - The queue key of the flushed request.
 * @param erc20Address - The ERC20 the request approves, the context's by default.
 * @returns The request id recorded on the vault ledger.
 * @throws {Error} When the recomputed request id is not on the ledger.
 */
export async function sendApproveRouter(
  context: VaultContext,
  key: Uint8Array,
  erc20Address: string = context.erc20Address,
): Promise<RequestIdHex> {
  const erc20 = evmAddressBytes(erc20Address);
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "approve");
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: erc20,
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
          words: [
            evmAddressAbiWord(evmAddressBytes(UNISWAP_SWAP_ROUTER_02)),
            numericAbiWord(MAX_APPROVE),
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
  const result = await context.vault.callTx.sendApproveRouter(key);
  console.log(`approveRouter sent in tx ${result.public.txId}`);
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
 * Queues, flushes and sends an approve(router) request.
 *
 * @param context - The vault context.
 * @param erc20Address - The ERC20 to approve, the context's by default.
 * @returns The request id recorded on the vault ledger.
 */
export async function approveRouter(
  context: VaultContext,
  erc20Address: string = context.erc20Address,
): Promise<RequestIdHex> {
  const key = await queueApproveRouter(context, erc20Address);
  await flushUntilStamped(context, key);
  return sendApproveRouter(context, key, erc20Address);
}

/**
 * Approves the Uniswap router from the vault account unless an allowance already exists.
 *
 * @param session - The vault session.
 */
export async function ensureRouterApproved(session: VaultSession): Promise<void> {
  const context = await session.vaultContext();
  const { ethers } = await import("ethers");
  const token = new ethers.Contract(
    context.erc20Address,
    ["function allowance(address,address) view returns (uint256)"],
    new ethers.JsonRpcProvider(context.evmRpcUrl),
  );
  const allowance: bigint = await token.getFunction<ContractReadMethod<bigint>>("allowance")(
    context.evmVaultAddress,
    UNISWAP_SWAP_ROUTER_02,
  );
  if (allowance > 0n) {
    logSkip(
      "approveRouter",
      `router already approved for ${context.erc20Address} (allowance ${String(allowance)})`,
    );
    return;
  }

  const requestId = await approveRouter(context);
  // approve is signed by the VAULT's account, then broadcast; no attestation/settle.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
  });
  await broadcastEvm(context, { transaction: signed });
  console.log(`router approved for ${context.erc20Address}`);
}
