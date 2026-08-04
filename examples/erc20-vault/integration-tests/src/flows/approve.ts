// `approveRouter`: record an approve(uniswapRouter, ~unlimited) SignBidirectionalEvent on
// the vault's ledger (field 0, a 2-word call like transfer), have the MPC sign it with the
// VAULT's account, and broadcast it. Sign-only: nothing is minted and there is no settle
// circuit, so the round trip ends at the broadcast. One-time per token; the allowance is
// global (one pooled account), so the first caller readies a token for everyone.
import {
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  requestIdHex,
  stripHexPrefix,
  asciiPadded,
  PATH_BYTES,
  SIGNET_DEFAULT_KEY_VERSION,
  TxParamType,
  calculateRequestId,
  toSignBidirectionalEventIndex,
  type SignBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

import { getTransactionNonce, logSkip } from "@midnight-examples/test-harness";

import {
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
  evmAddressBytes,
} from "../evm-transfer.ts";
import {
  APPROVE_SELECTOR,
  MAX_APPROVE,
  UNISWAP_SWAP_ROUTER_02,
  uniswapAvailable,
} from "../evm-swap.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;

/** Record the approveRouter request and return its id. */
export async function approveRouter(context: VaultContext, evmNonce: bigint): Promise<RequestIdHex> {
  const erc20 = evmAddressBytes(context.erc20Address);
  const before = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!before.initialized) throw new Error("vault is not initialized, run the initialize flow first");

  // approve(router, MAX) on the ERC20, signed with the vault account (path "vault"), same
  // 2-word map + bool schema as a transfer.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce: evmNonce,
      gasLimit: ERC20_TRANSFER_GAS_LIMIT,
      maxFeePerGas: ERC20_TRANSFER_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: APPROVE_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(evmAddressBytes(UNISWAP_SWAP_ROUTER_02)), numericAbiWord(MAX_APPROVE)],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));
  const result = await context.vault.callTx.approveRouter(erc20, evmNonce, SIGNET_DEFAULT_KEY_VERSION);
  console.log(`approveRouter finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed approve request id ${expectedIdHex} not found on the ledger`);
  }
  return expectedIdHex;
}

/**
 * Ensure the vault account has approved the router for `context.erc20Address`: read the
 * live allowance, and if it is zero run the approve leg (request -> sign -> broadcast; no
 * settle). Idempotent and global — a nonzero allowance short-circuits.
 */
export async function ensureRouterApproved(session: VaultSession): Promise<void> {
  const context = await session.vaultContext();
  if (!(await uniswapAvailable(context.evmRpcUrl))) {
    logSkip("approveRouter", "Uniswap router not deployed on this EVM chain");
    return;
  }
  const { ethers } = await import("ethers");
  const token = new ethers.Contract(
    context.erc20Address,
    ["function allowance(address,address) view returns (uint256)"],
    new ethers.JsonRpcProvider(context.evmRpcUrl),
  );
  const allowance: bigint = await token.allowance(context.evmVaultAddress, UNISWAP_SWAP_ROUTER_02);
  if (allowance > 0n) {
    logSkip("approveRouter", `router already approved for ${context.erc20Address} (allowance ${allowance})`);
    return;
  }

  const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
  const requestId = await approveRouter(context, evmNonce);
  // approve is signed by the VAULT's account, then broadcast; no attestation/settle.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    expectedSigner: context.evmVaultAddress,
  });
  await broadcastEvm(context, { transaction: signed });
  console.log(`router approved for ${context.erc20Address}`);
}

