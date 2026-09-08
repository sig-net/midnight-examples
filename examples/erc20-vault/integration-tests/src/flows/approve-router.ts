// `approveRouter`: both phases of the approve(uniswapRouter, ~unlimited) on one ERC20. Phase 1
// (`requestApproveRouter`) parks the token in the vault's EVM nonce allocator; phase 2
// (`assignApproveRouter`) proves the slot it landed in and records the SignBidirectionalEvent on
// the vault's ledger (field 0, a 2-word call like transfer) at the EVM nonce that slot owns. The
// MPC then signs it with the VAULT's account and it is broadcast. Sign-only: nothing is minted
// and there is no settle circuit, so the round trip ends at the broadcast. One-time per token;
// the allowance is global (one pooled account), so the first caller readies a token for everyone.
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
  evmAddressBytes,
  readVaultLedger,
  UNISWAP_SWAP_ROUTER_02,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { type ContractReadMethod, logSkip } from "@sig-net/midnight-examples-test-harness";

import { APPROVE_SELECTOR, MAX_APPROVE } from "../evm-swap.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;

/** What {@link approveRouter} hands back: the recorded request, plus the salt it was keyed on. */
export interface StartedApproveRouter {
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
 * Record the approveRouter request (both phases) and return its id.
 *
 * @param context - The flow context.
 * @returns The recorded request id and the salt the request was keyed on.
 */
export async function approveRouter(context: VaultContext): Promise<StartedApproveRouter> {
  const erc20 = evmAddressBytes(context.erc20Address);
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

  // Phase 1: park the token under requestCommitment(secret, salt). A fresh random salt,
  // because the key must be one this caller has never parked before.
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const requested = await context.vault.callTx.requestApproveRouter(
    erc20,
    SIGNET_DEFAULT_KEY_VERSION,
    salt,
  );
  console.log(`requestApproveRouter finalized in tx ${requested.public.txId}`);

  const key = vaultRequestKey(context, salt);
  const slot = await resolveRequestSlot(context, key);
  console.log(
    `approveRouter allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`,
  );

  // approve(router, MAX) on the ERC20, signed with the vault account (path "vault"), same
  // 2-word map + bool schema as a transfer, at the slot's nonces.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: slot.index,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: asciiPadded("vault", PATH_BYTES),
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: erc20,
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
          words: [
            evmAddressAbiWord(evmAddressBytes(UNISWAP_SWAP_ROUTER_02)),
            numericAbiWord(MAX_APPROVE),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignApproveRouter(key, slot.path);
  console.log(`assignApproveRouter finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.signBidirectionalEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed approve request id ${expectedIdHex} not found on the ledger`);
  }
  return { requestId: expectedIdHex, salt };
}

/**
 * Ensure the vault account has approved the router for `context.erc20Address`: read the
 * live allowance, and if it is zero run the approve leg (request -> assign -> sign ->
 * broadcast; no settle). Idempotent and global — a nonzero allowance short-circuits.
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

  // No nonce is read from the chain: the allocator hands the approve its EVM nonce, the same
  // way it hands one to every other vault-signed request.
  const { requestId } = await approveRouter(context);
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
