// `startSwap` then `sendSwap`: surrender a shielded vault coin of the sold ERC20
// (burned by the contract), flush the queued swap, which assigns it the vault
// account's next EVM nonce, and record its SignBidirectionalEvent in the vault's
// bidirectionalSwapMap. It asks the MPC to sign an EVM `exactOutputSingle` on the
// pinned Uniswap router, sent from the VAULT's derived address (path "vault"). The
// request id is recomputed off-chain with the library's TS twin of the request-id
// circuit and asserted against the ledger map index before it is returned. The
// settle side lives in complete-swap.ts.
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
  Action,
  evmAddressBytes,
  flushedRequestIndex,
  newInputIndex,
  readVaultLedger,
  VAULT_PATH_BYTES,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { logEvmFeeCap, logTokenAmount } from "../evm-logging.ts";
import { EXACT_OUTPUT_SINGLE_SELECTOR } from "../evm-swap.ts";
import { SWAP_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTokenType } from "../vault-token.ts";
import { flushUntil } from "./vault-queue.ts";

/** Options for {@link startSwap}. The sold ERC20 is the context's `erc20Address`. */
export interface StartSwapOptions {
  /** The ERC20 to buy (20-byte 0x hex). */
  readonly erc20AddressOut: string;
  /** The Uniswap V3 pool fee tier (500, 3000, ...). */
  readonly fee: bigint;
  /** The exact amount of `erc20AddressOut` to receive, in its base units. */
  readonly amountOut: bigint;
  /** The most of the sold ERC20 the swap may spend, in its base units: the coin surrendered. */
  readonly amountInMaximum: bigint;
}

/**
 * Queue a swap with `startSwap` under a fresh input index, flush it into the
 * output buffer, send it with `sendSwap`, and return the resulting request id.
 *
 * Surrenders a shielded vault coin of the context's ERC20 worth exactly
 * `amountInMaximum`: its colour comes from the compiled
 * `vaultTokenDomainSeparator` circuit plus the runtime's `rawTokenType`, and
 * midnight-js funds its value from the caller's shielded balance when it
 * balances the call. The entry pins an ownership commitment of this wallet's
 * identity secret, so only this caller can complete the swap and take its
 * mints. The caller chooses only the swap itself: the vault's account signs,
 * so the contract copies the vault's gas settings at start and the flush
 * assigns the nonce. The expected record is reconstructed off-chain from the
 * flushed entry and its stored arguments, its id computed with the library's
 * `calculateRequestId` TS twin, and asserted present as a ledger map index after
 * the send.
 *
 * @param context - The flow context.
 * @param options - The swap arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If an option is invalid, the vault is uninitialised, the
 *   caller's shielded balance cannot cover `options.amountInMaximum`, or the
 *   recomputed id does not appear on the ledger.
 */
export async function startSwap(
  context: VaultContext,
  options: StartSwapOptions,
): Promise<RequestIdHex> {
  if (options.amountOut <= 0n) {
    throw new Error(`amountOut must be a positive integer; got ${String(options.amountOut)}.`);
  }
  if (options.amountInMaximum <= 0n) {
    throw new Error(
      `amountInMaximum must be a positive integer; got ${String(options.amountInMaximum)}.`,
    );
  }
  const erc20AddressIn = evmAddressBytes(context.erc20Address);
  const erc20AddressOut = evmAddressBytes(options.erc20AddressOut);
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`erc20 in:       ${context.erc20Address}`);
  console.log(`erc20 out:      ${options.erc20AddressOut}`);

  await logTokenAmount(
    context.evmRpcUrl,
    context.erc20Address,
    context.evmVaultAddress,
    options.amountInMaximum,
    "swap maximum input",
  );
  await logTokenAmount(
    context.evmRpcUrl,
    options.erc20AddressOut,
    context.evmVaultAddress,
    options.amountOut,
    "swap output",
  );
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }

  // The surrendered coin: the vault token of the sold ERC20, of exactly
  // amountInMaximum, under a fresh random nonce.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
    value: options.amountInMaximum,
  };

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startSwap(
    inIndex,
    {
      erc20AddressIn,
      erc20AddressOut,
      fee: options.fee,
      amountOut: options.amountOut,
      amountInMaximum: options.amountInMaximum,
    },
    coin,
  );
  console.log(`swap queued in tx ${queued.public.txId}`);
  const flushed = await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const outIndex = flushedRequestIndex(flushed, Action.swap, inIndex);
  const { evmNonce } = flushed.outputRequestBuffer.lookup(outIndex).entry;
  const { gas } = flushed.swapArgsMap.lookup(inIndex);
  console.log(`vault EVM nonce: ${String(evmNonce)}`);

  // The record the contract will store, reconstructed byte for byte: the event's
  // own sender (the vault contract, kernel.self() in-circuit), the pinned chain
  // and router, the nonce the flush assigned, the gas the start copied, the
  // contract-built `exactOutputSingle((in, out, fee, recipient = the vault's EVM
  // account, amountOut, amountInMaximum, no price limit))` calldata (the raw
  // selector and the ABI-ready big-endian words, as broadcast), the vault's own
  // 32-byte derivation path, and the contract-fixed routing with the swap's
  // schemas.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...SWAP_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: before.uniswapRouter,
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
          selector: EXACT_OUTPUT_SINGLE_SELECTOR,
          noWords: 7n,
          words: [
            evmAddressAbiWord(erc20AddressIn),
            evmAddressAbiWord(erc20AddressOut),
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
  logEvmFeeCap(
    expectedIdHex,
    context.evmVaultAddress,
    expectedRecord.txParams.gasLimit,
    expectedRecord.txParams.maxFeePerGas,
    expectedRecord.txParams.maxPriorityFeePerGas,
  );

  const result = await context.vault.callTx.sendSwap(outIndex);
  console.log(`swap sent in tx ${result.public.txId}`);

  // The bidirectionalSwapMap index IS the record's transientHash digest:
  // recomputing it off-chain and finding it on the ledger proves both sides agree
  // on every byte of the event.
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalSwapMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's swap map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}
