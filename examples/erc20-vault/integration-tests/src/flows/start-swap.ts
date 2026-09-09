// `startSwap`: both phases of the swap request. Phase 1 (`requestSwap`) surrenders
// amountInMaximum of the tokenIn vault coin (burned) and parks the swap parameters in the
// vault's EVM nonce allocator. Phase 2 (`assignSwap`) proves the allocator slot the request
// key landed in and records the exactOutputSingle SignBidirectionalEvent on the vault's SWAP
// ledger map, to be signed with the VAULT's account at the EVM nonce that slot owns and
// broadcast. The settle side lives in complete-swap.ts.
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
  evmAddressBytes,
  readVaultLedger,
  VAULT_PATH_BYTES,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { EXACT_OUTPUT_SINGLE_SELECTOR, SWAP_MPC_ROUTING } from "../evm-swap.ts";
import type { VaultContext } from "../vault-context.ts";
import { resolveRequestSlot, vaultRequestKey } from "../vault-slots.ts";
import { vaultTokenType } from "../vault-token.ts";

/** Options for {@link startSwap}. */
export interface StartSwapOptions {
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountOut: bigint;
  readonly amountInMaximum: bigint;
}

/** What {@link startSwap} hands back: the recorded request, plus what settling it needs. */
export interface StartedSwap {
  /** The recorded swap request id. */
  readonly requestId: RequestIdHex;
  /**
   * The surrendered coin's nonce — the value the request was keyed on. The
   * settle-view `commitment` is `requestCommitment(secret, coinNonce)`, so
   * `completeSwap` / `refundSwap` take this back as their `commitmentNonce`.
   */
  readonly coinNonce: Uint8Array;
}

/**
 * Record the swap request (exactOutputSingle) and return its id. tokenIn = context.erc20Address.
 *
 * Two phases: `requestSwap` burns the coin and parks the parameters under
 * `requestCommitment(secret, coin.nonce)`, then `assignSwap` presents the Merkle path proving
 * where that key landed in `slots`, which is what fixes the EVM tx nonce (`evmNonceBase +
 * slotIndex`) and the event's request nonce (the slot index). Neither phase takes a
 * caller-supplied EVM nonce, so the expected record can only be rebuilt once phase 1 has
 * applied and the slot is known.
 *
 * @param context - The flow context.
 * @param options - The swap parameters (tokenOut, fee, amountOut, amountInMaximum).
 * @returns The recorded swap request id and the surrendered coin's nonce.
 */
export async function startSwap(
  context: VaultContext,
  options: StartSwapOptions,
): Promise<StartedSwap> {
  const tokenIn = evmAddressBytes(context.erc20Address);
  const tokenOut = evmAddressBytes(options.tokenOut);
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
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(before, "swap");

  // Surrender the tokenIn vault coin of exactly amountInMaximum (burned; completeSwap returns
  // the unspent remainder as change). Its nonce keys the request in the allocator.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amountInMaximum,
  };

  // Phase 1: burn and park. No request id exists yet.
  const requested = await context.vault.callTx.requestSwap(
    SIGNET_DEFAULT_KEY_VERSION,
    {
      tokenIn,
      tokenOut,
      fee: options.fee,
      amountOut: options.amountOut,
      amountInMaximum: options.amountInMaximum,
    },
    coin,
  );
  console.log(`requestSwap finalized in tx ${requested.public.txId}`);

  const key = vaultRequestKey(context, coin.nonce);
  const slot = await resolveRequestSlot(context, key);
  console.log(
    `swap allocator slot: ${String(slot.index)} (vault evm nonce ${String(slot.evmNonce)})`,
  );

  // The record the contract composes: vault path/sender, the slot's request and EVM nonces,
  // router `to`, contract-fixed gas, exactOutputSingle((tokenIn, tokenOut, fee,
  // recipient=vault, amountOut, amountInMaximum, 0)).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    // A constant, for every VAULT-signed flow: the EVM nonce inside txParams is
    // already unique per request (one vault account, one nonce each), so the
    // circuit hashes a 0 here rather than a second copy of that uniqueness.
    requestNonce: 0n,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SWAP_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: before.uniswapRouter,
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
          selector: EXACT_OUTPUT_SINGLE_SELECTOR,
          noWords: 7n,
          words: [
            evmAddressAbiWord(tokenIn),
            evmAddressAbiWord(tokenOut),
            numericAbiWord(options.fee),
            evmAddressAbiWord(before.vaultEvmAddress),
            numericAbiWord(options.amountOut),
            numericAbiWord(options.amountInMaximum),
            numericAbiWord(0n),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  // Phase 2: prove the slot and record the event for the MPC.
  const result = await context.vault.callTx.assignSwap(key, slot.path);
  console.log(`assignSwap finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.swapEventMap).has(expectedIdHex)) {
    throw new Error(`recomputed swap request id ${expectedIdHex} not found on the swap ledger map`);
  }
  console.log(`swap request id:   ${expectedIdHex}`);
  return { requestId: expectedIdHex, coinNonce: coin.nonce };
}
