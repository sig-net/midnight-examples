// `approveStata`: both phases of the one-time approve(stataToken, ~unlimited) on the pinned
// underlying (USDC), so the wrapper can pull USDC during a supply. Phase 1
// (`requestApproveStata`) parks the request in the vault's EVM nonce allocator; phase 2
// (`assignApproveStata`) proves the slot it landed in and records the SignBidirectionalEvent on
// the vault's ledger (field 0) at the EVM nonce that slot owns. The MPC then signs it with the
// VAULT's account and it is broadcast. Sign-only (nothing minted, no settle circuit), so the
// round trip ends at the broadcast.
//
// The approve surrenders no coin, so it has no coin nonce to key on: it passes a caller-chosen
// random SALT instead. It is two-phase anyway because it spends the SAME pooled EVM account as
// the four value flows — a second source of nonces would collide with them the moment an
// approve and a withdraw are in flight together.
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
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;

/** What {@link approveStata} hands back: the recorded request, plus the salt it was keyed on. */
export interface StartedApproveStata {
  /** The recorded request id. */
  readonly requestId: RequestIdHex;
  /**
   * The random salt standing in for a coin nonce: what
   * `requestCommitment(secret, salt)` — the allocator leaf — was built over.
   * The approve has no settle circuit, so nothing consumes it; it is returned
   * for symmetry with the value flows and so a caller can recompute the key.
   */
  readonly salt: Uint8Array;
}

/**
 * Record the approveStata request (both phases) and return its id.
 *
 * @param context - The flow context.
 * @returns The recorded request id and the salt the request was keyed on.
 */
export async function approveStata(context: VaultContext): Promise<StartedApproveStata> {
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

  // Phase 1: park the request under requestCommitment(secret, salt). A fresh random salt,
  // because the key must be one this caller has never parked before.
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const requested = await context.vault.callTx.requestApproveStata(
    SIGNET_DEFAULT_KEY_VERSION,
    salt,
  );
  console.log(`requestApproveStata finalized in tx ${requested.public.txId}`);

  const key = vaultRequestKey(context, salt);
  const slot = await resolveRequestSlot(context, key);
  console.log(
    `approveStata allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`,
  );

  // approve(stataToken, MAX) on the underlying USDC, signed with the vault account (path
  // "vault"), the same 2-word map + bool schema as a transfer, at the slot's nonces.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: slot.index,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: evmAddressBytes(AAVE_USDC),
      chainId: before.evmChainId,
      nonce: slot.evmNonce,
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

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignApproveStata(key, slot.path);
  console.log(`assignApproveStata finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed approveStata request id ${expectedIdHex} not found on the ledger`);
  }
  return { requestId: expectedIdHex, salt };
}

/**
 * Ensure the vault account has approved the stataToken to pull the underlying: read the live
 * allowance, and if it is zero run the approve leg (request -> assign -> sign -> broadcast; no
 * settle). Idempotent and global.
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

  // No nonce is read from the chain: the allocator hands the approve its EVM nonce, the same
  // way it hands one to every other vault-signed request.
  const { requestId } = await approveStata(context);
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    expectedSigner: context.evmVaultAddress,
  });
  await broadcastEvm(context, { transaction: signed });
  console.log("stataToken approved to pull the underlying");
}
