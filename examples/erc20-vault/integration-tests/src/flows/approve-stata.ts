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
  readVaultLedger,
  STATA_USDC,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { type ContractReadMethod, logSkip } from "@sig-net/midnight-examples-test-harness";

import { APPROVE_SELECTOR, MAX_APPROVE } from "../evm-stata.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;

/**
 * Record the approveStata request and return its id.
 *
 * The vault EVM account's nonce is NOT an argument: approveStata signs from the same shared
 * vault account as the queued flows, so the contract's own `vaultEvmNonce` counter assigns it
 * (see ./flush.ts). It is read here only to recompute the record off-chain.
 *
 * @param context - The flow context.
 * @returns The recorded request id.
 */
export async function approveStata(context: VaultContext): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised)
    throw new Error("vault is not initialised, run the initialise flow first");

  // The gas envelope the circuit itself will stamp, read from the ledger the
  // deployer's setGasParams writes. Read, never mirrored as a constant: the
  // envelope is hashed into the request id, so a stale copy recomputes the
  // wrong id the moment the cap is raised.
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "approve");

  // approve(stataToken, MAX) on the underlying USDC, signed with the vault account (path
  // "vault"), the same 2-word map + bool schema as a transfer.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: evmAddressBytes(AAVE_USDC),
      chainId: before.evmChainId,
      nonce: before.vaultEvmNonce,
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
  const result = await context.vault.callTx.approveStata(SIGNET_DEFAULT_KEY_VERSION);
  console.log(`approveStata finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed approveStata request id ${expectedIdHex} not found on the ledger`);
  }
  return expectedIdHex;
}

/**
 * Ensure the vault account has approved the stataToken to pull the underlying: read the live
 * allowance, and if it is zero run the approve leg (request -> sign -> broadcast; no settle).
 * Idempotent and global.
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
    timeoutMs: 2 * MINUTE,
    expectedSigner: context.evmVaultAddress,
  });
  await broadcastEvm(context, { transaction: signed });
  console.log("stataToken approved to pull the underlying");
}
