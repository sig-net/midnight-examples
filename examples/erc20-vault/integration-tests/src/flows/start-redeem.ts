// `startRedeem` then `sendRedeem`: surrender a shielded vault coin of the pinned
// stataToken wrapper (burned by the contract), flush the queued redeem, which assigns
// it the vault account's next EVM nonce, and record its SignBidirectionalEvent in the
// vault's bidirectionalRedeemMap. It asks the MPC to sign an EVM `redeem(shares,
// vault, vault)` on the wrapper, sent from the VAULT's derived address (path
// "vault"). The request id is recomputed off-chain with the library's TS twin of the
// request-id circuit and asserted against the ledger map index before it is returned.
// The settle side lives in complete-redeem.ts.
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
  flushedRequestIndex,
  newInputIndex,
  readVaultLedger,
  VAULT_PATH_BYTES,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { logEvmFeeCap, logTokenAmount } from "../evm-logging.ts";
import { STATA_REDEEM_SELECTOR } from "../evm-stata.ts";
import { REDEEM_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { vaultTokenType } from "../vault-token.ts";
import { flushUntil } from "./vault-queue.ts";

/** Options for {@link startRedeem}. */
export interface StartRedeemOptions {
  /** The stataToken shares to redeem, in the wrapper's base units. */
  readonly shares: bigint;
}

/**
 * Queue a redeem with `startRedeem` under a fresh input index, flush it into
 * the output buffer, send it with `sendRedeem`, and return the resulting
 * request id.
 *
 * Surrenders a shielded vault coin of exactly `shares` of the vault's pinned
 * stataToken: its colour comes from the compiled `vaultTokenDomainSeparator`
 * circuit plus the runtime's `rawTokenType`, and midnight-js funds its value
 * from the caller's shielded balance when it balances the call. The entry pins
 * an ownership commitment of this wallet's identity secret, so only this caller
 * can complete the redeem and take its assets or its re-mint. The caller
 * chooses only the shares: the contract pins both tokens, the vault's account
 * signs, so the contract copies the vault's gas settings at start and the flush
 * assigns the nonce. The expected record is reconstructed off-chain from the
 * flushed entry and its stored arguments, its id computed with the library's
 * `calculateRequestId` TS twin, and asserted present as a ledger map index after
 * the send.
 *
 * @param context - The flow context.
 * @param options - The redeem arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If the shares are not positive, the vault is uninitialised,
 *   the caller's shielded balance cannot cover `options.shares`, or the
 *   recomputed id does not appear on the ledger.
 */
export async function startRedeem(
  context: VaultContext,
  options: StartRedeemOptions,
): Promise<RequestIdHex> {
  if (options.shares <= 0n) {
    throw new Error(`shares must be a positive integer, got ${String(options.shares)}.`);
  }
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  const wrapper = `0x${bytesToHex(before.stataToken)}`;
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`wrapper:        ${wrapper}`);
  console.log(`underlying:     0x${bytesToHex(before.stataUnderlying)}`);
  await logTokenAmount(
    context.evmRpcUrl,
    wrapper,
    context.evmVaultAddress,
    options.shares,
    "start-redeem shares",
  );

  // The surrendered coin: the vault token for the pinned wrapper, of exactly
  // `shares`, under a fresh random nonce.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(wrapper, context.vaultContractAddress)),
    value: options.shares,
  };

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startRedeem(inIndex, { shares: options.shares }, coin);
  console.log(`redeem queued in tx ${queued.public.txId}`);
  const flushed = await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const outIndex = flushedRequestIndex(flushed, Action.redeem, inIndex);
  const { evmNonce } = flushed.outputRequestBuffer.lookup(outIndex).entry;
  const { gas } = flushed.redeemArgsMap.lookup(inIndex);
  console.log(`vault EVM nonce: ${String(evmNonce)}`);

  // The record the contract will store, reconstructed byte for byte: the event's
  // own sender (the vault contract, kernel.self() in-circuit), the pinned chain,
  // the nonce the flush assigned, the gas the start copied, the contract-built
  // `redeem(shares, vault, vault)` calldata on the pinned wrapper (the raw selector,
  // the ABI-ready big-endian shares, receiver and owner words, as broadcast), the
  // vault's own 32-byte derivation path, and the contract-fixed routing under the
  // redeem's schemas.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...REDEEM_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: before.stataToken,
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
  logEvmFeeCap(
    expectedIdHex,
    context.evmVaultAddress,
    expectedRecord.txParams.gasLimit,
    expectedRecord.txParams.maxFeePerGas,
    expectedRecord.txParams.maxPriorityFeePerGas,
  );

  const result = await context.vault.callTx.sendRedeem(outIndex);
  console.log(`redeem sent in tx ${result.public.txId}`);

  // The bidirectionalRedeemMap index IS the record's transientHash digest:
  // recomputing it off-chain and finding it on the ledger proves both sides agree
  // on every byte of the event.
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalRedeemMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's redeem map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}
