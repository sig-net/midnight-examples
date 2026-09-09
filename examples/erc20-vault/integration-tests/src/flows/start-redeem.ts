// `startRedeem`: both phases of the redeem request. Phase 1 (`requestRedeem`) surrenders
// `shares` of the stataUSDC vault coin (burned) and parks the shares in the vault's EVM nonce
// allocator. Phase 2 (`assignRedeem`) proves the allocator slot the request key landed in and
// records a stataToken.redeem(shares, vault, vault) SignBidirectionalEvent on the vault's
// REDEEM ledger map, to be signed with the VAULT's account at the EVM nonce that slot owns and
// broadcast. The settle side lives in complete-redeem.ts.
import {
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
  readVaultLedger,
  STATA_USDC,
  VAULT_PATH_BYTES,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { REDEEM_MPC_ROUTING, STATA_REDEEM_SELECTOR } from "../evm-stata.ts";
import type { VaultContext } from "../vault-context.ts";
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { vaultTokenType } from "../vault-token.ts";

/** Options for {@link startRedeem}. */
export interface StartRedeemOptions {
  readonly shares: bigint;
}

/** What {@link startRedeem} hands back: the recorded request, plus what settling it needs. */
export interface StartedRedeem {
  /** The recorded redeem request id. */
  readonly requestId: RequestIdHex;
  /**
   * The surrendered coin's nonce — the value the request was keyed on. The
   * settle-view `commitment` is `requestCommitment(secret, coinNonce)`, so
   * `completeRedeem` / `refundRedeem` take this back as their `commitmentNonce`.
   */
  readonly coinNonce: Uint8Array;
}

/**
 * Record the redeem request (stataToken.redeem(shares, vault, vault)) and return its id. The
 * burned coin is the stataUSDC vault token of exactly `shares`.
 *
 * Two phases: `requestRedeem` burns the coin and parks the shares under
 * `requestCommitment(secret, coin.nonce)`, then `assignRedeem` presents the Merkle path
 * proving where that key landed in `slots`, which is what fixes the EVM tx nonce
 * (`evmNonceBase + slotIndex`) and the event's request nonce (the slot index). Neither phase
 * takes a caller-supplied EVM nonce, so the expected record can only be rebuilt once phase 1
 * has applied and the slot is known.
 *
 * @param context - The flow context.
 * @param options - The redeem parameters (shares).
 * @returns The recorded redeem request id and the surrendered coin's nonce.
 */
export async function startRedeem(
  context: VaultContext,
  options: StartRedeemOptions,
): Promise<StartedRedeem> {
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
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "redeem");

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(STATA_USDC, context.vaultContractAddress)),
    value: options.shares,
  };

  // Phase 1: burn and park. No request id exists yet.
  const requested = await context.vault.callTx.requestRedeem(
    SIGNET_DEFAULT_KEY_VERSION,
    options.shares,
    coin,
  );
  console.log(`requestRedeem finalized in tx ${requested.public.txId}`);

  const key = vaultRequestKey(context, coin.nonce);
  const slot = await resolveRequestSlot(context, key);
  console.log(
    `redeem allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`,
  );

  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    // A constant, for every VAULT-signed flow: the EVM nonce inside txParams is
    // already unique per request (one vault account, one nonce each), so the
    // circuit hashes a 0 here rather than a second copy of that uniqueness.
    requestNonce: 0n,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...REDEEM_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: before.stataToken,
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
          selector: STATA_REDEEM_SELECTOR,
          noWords: 3n,
          words: [
            numericAbiWord(options.shares),
            evmAddressAbiWord(before.vaultEvmAddress),
            evmAddressAbiWord(before.vaultEvmAddress),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignRedeem(key, slot.path);
  console.log(`assignRedeem finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.redeemEventMap).has(expectedIdHex)) {
    throw new Error(
      `recomputed redeem request id ${expectedIdHex} not found on the redeem ledger map`,
    );
  }
  console.log(`redeem request id: ${expectedIdHex}`);
  return { requestId: expectedIdHex, coinNonce: coin.nonce };
}
