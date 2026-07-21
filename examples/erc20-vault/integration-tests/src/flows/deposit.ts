// `deposit`: record a deposit SignBidirectionalEvent on the vault's ledger,
// plus the whole deposit leg as one arrange-stage helper
// ({@link runDepositRoundTrip}). The deposit is the first half of the deposit
// flow: it asks the MPC to sign an EVM `transfer(vault, amount)` on the
// ERC20, sent from the user's derived address. The request id is recomputed
// off-chain with the library's TS twin of the request-id circuit and asserted
// against the ledger map key before it is returned.

import {
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWordValue,
  requestIdBytes,
  requestIdHex,
  stripHexPrefix,
  SIGNET_DEFAULT_KEY_VERSION,
  TxParamType,
  calculateRequestId,
  executionSucceeded,
  toSignBidirectionalEventIndex,
  type SignBidirectionalEvent,
  type RequestIdHex,
} from "@sig-net/midnight";

import { getTransactionNonce, logSkip } from "@midnight-examples/test-harness";

import {
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
  evmAddressBytes,
} from "../evm-transfer.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { claim, type ShieldedTokenRecipient } from "./claim.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;

/** Options for {@link deposit}. */
export interface DepositOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** Nonce of the user's derived EVM account (the sweep tx sender). */
  readonly evmNonce: bigint;
}

/**
 * Call the vault's `deposit` circuit on the deployed contract and return the
 * resulting request id.
 *
 * The circuit takes only what the caller genuinely chooses: their derived
 * account's nonce, the gas envelope (this flow uses the shared
 * `ERC20_TRANSFER_*` defaults, and the caller's account pays), the MPC key
 * version, and the deposit itself. Everything else (chain, calldata, routing,
 * and even the derivation path, which is the caller's identity commitment
 * recomputed in-circuit) is contract-composed from the initialize-pinned
 * config. The expected event record is reconstructed off-chain (chain fields
 * read from the ledger, routing from the {@link VAULT_MPC_ROUTING} mirror),
 * its id computed with the library's `calculateRequestId` TS twin, and
 * asserted present as a ledger map key after the call.
 *
 * @param context - The flow context.
 * @param options - The deposit arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws If an option is invalid, the vault is uninitialized, or the
 *   recomputed id does not appear on the ledger.
 */
export async function deposit(context: VaultContext, options: DepositOptions): Promise<RequestIdHex> {
  if (options.amount <= 0n) {
    throw new Error(`amount must be a positive integer; got ${options.amount}.`);
  }
  if (options.evmNonce < 0n) {
    throw new Error(`evmNonce must be non-negative; got ${options.evmNonce}.`);
  }
  const erc20 = evmAddressBytes(context.erc20Address);
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`erc20:             ${context.erc20Address}`);
  console.log(`amount:            ${options.amount} (evm nonce ${options.evmNonce})`);
  console.log(`caller commitment: ${context.identity.commitmentHex}`);

  // Pre-call ledger read: the request nonce the contract will use, the sealed
  // vault EVM address its calldata will pay to, and the pinned chain config.
  const before = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!before.initialized) {
    throw new Error("vault is not initialized, run the initialize flow first");
  }
  const requestNonce = before.signetRequestNonce;
  const vaultEvmAddress = before.vaultEvmAddress;

  const gasLimit = ERC20_TRANSFER_GAS_LIMIT;
  const maxFeePerGas = ERC20_TRANSFER_MAX_FEE_PER_GAS;
  const maxPriorityFeePerGas = ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS;
  const keyVersion = SIGNET_DEFAULT_KEY_VERSION;

  // The record the contract will store, reconstructed byte for byte: the
  // event's own sender (the vault contract, kernel.self() in-circuit), the
  // contract-composed envelope on the initialize-pinned chain, the
  // contract-built `transfer(vaultEvmAddress, amount)` calldata (the raw
  // selector, the big-endian address embed, the LE amount embed), the
  // caller's identity commitment as the 32-byte derivation path, and the
  // contract-fixed routing.
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce,
    keyVersion,
    path: context.identity.commitment,
    ...VAULT_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(vaultEvmAddress),
            numericAbiWordValue(options.amount),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.deposit(
    options.evmNonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    keyVersion,
    {
      erc20Address: erc20,
      amount: options.amount,
    },
  );
  console.log(`deposit finalized in tx ${result.public.txId}`);

  // The ledger map key IS the record's persistent hash: recomputing it
  // off-chain and finding it on the ledger proves both sides agree on every
  // byte of the event.
  const after = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  const index = toSignBidirectionalEventIndex(after.signBidirectionalEventMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found on the ledger — ` +
        `present ids: [${[...index.keys()].join(", ")}] (was another request submitted concurrently?)`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}

/** Options for {@link runDepositRoundTrip}. */
export interface DepositRoundTripOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /**
   * Resume from an existing request instead of calling {@link deposit} —
   * for recovering a run that died mid-round-trip (e.g. the proof server
   * OOM-killed at the claim step). Every later leg is naturally idempotent:
   * the signature response and attestation persist on the signet ledger,
   * `broadcastEvm` short-circuits on a mined sweep, and an already-claimed
   * request skips the claim.
   */
  readonly reuseRequestId?: RequestIdHex;
  /**
   * The wallet the claim mints the shielded vault tokens to; the caller's
   * own wallet when omitted. Passed through to {@link claim} — only the
   * depositor (the session wallet) may claim either way.
   */
  readonly claimRecipient?: ShieldedTokenRecipient;
  /**
   * Stop after the attestation poll instead of claiming, leaving the request
   * on the ledger with its attestation posted — claimable by the depositor.
   * For flows that own the claim step themselves (false-claimer); `claimed`
   * in the result is then always `false`.
   */
  readonly skipClaim?: boolean;
}

/** What {@link runDepositRoundTrip} hands back to the flow file. */
export interface DepositRoundTripResult {
  /** The deposit request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /**
   * Whether THIS run executed the claim. `false` means the request was
   * already claimed by a prior run (rerun against a kept contract address) —
   * the mint happened back then, so effects like a balance delta are not
   * observable in this run.
   */
  readonly claimed: boolean;
}

/**
 * Run the full deposit round trip against the live stack: fetch the user's
 * EVM nonce, {@link deposit}, poll the MPC's signature, broadcast the sweep,
 * poll the MPC's attestation, and {@link claim} — leaving the claim
 * recipient (`opts.claimRecipient`, the caller's own wallet by default)
 * holding `opts.amount` of freshly minted shielded vault tokens.
 *
 * Arrange-stage plumbing for flow files that need the caller to HOLD
 * shielded vault tokens (failure-refund, claimant-not-caller,
 * false-claimer…): it asserts each leg produced what the next one needs
 * (pointed throws, nothing skips silently), but carries none of the
 * golden-notification assertions the happy-day file owns — that file
 * deliberately does NOT use this helper, its long-hand steps carry per-leg
 * assertions. Rerun-tolerant against kept addresses: an already-claimed
 * request logs a skip instead of failing.
 *
 * @param session - The flow file's shared session.
 * @param opts - Deposit amount and optional resume id.
 * @returns The request id and whether this run executed the claim.
 * @throws If any leg times out, the MPC attests the sweep as failed, or the
 *   sweep transaction reverts on-chain.
 */
export async function runDepositRoundTrip(
  session: VaultSession,
  opts: DepositRoundTripOptions,
): Promise<DepositRoundTripResult> {
  const context = await session.vaultContext();

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("deposit", `resuming deposit round trip from existing request ${requestId}`);
  } else {
    // The sweep tx sender is the user's derived EVM account; its next nonce
    // comes from the chain, exactly as a wallet would fetch it.
    const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmUserAddress);
    requestId = await deposit(context, { amount: opts.amount, evmNonce });
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`deposit request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // Deposit sweeps are signed by the USER's derived account.
  const signedSweepTransaction = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    expectedSigner: context.evmUserAddress,
  });

  // Idempotent: an already-mined sweep short-circuits; a reverted or
  // nonce-burned sweep throws — either would starve the claim, so let it.
  await broadcastEvm(context, { transaction: signedSweepTransaction });

  const attestation = await pollRespondBidirectional(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
  });
  // This helper arranges a SUCCESSFUL deposit — a failure attestation means
  // the sweep did not land and the claim below could never mint.
  if (!executionSucceeded(attestation.serializedOutput)) {
    throw new Error(
      `the MPC attested deposit sweep ${requestId} as FAILED — ` +
        `the sweep broadcast above mined, so the responder saw a different outcome (stale responder config?)`,
    );
  }

  let claimed = false;
  if (opts.skipClaim) {
    logSkip("claim", `skipClaim set — request ${requestId} left unclaimed on the ledger`);
    return { requestId, claimed };
  }

  // Rerun against a kept contract address: a prior run may have already
  // claimed this request (claiming consumes it from the ledger) — the minted
  // tokens are already in the wallet, so skip instead of failing.
  const ledger = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  if (!ledger.signBidirectionalEventMap.member(requestIdBytes(requestId))) {
    logSkip("claim", `request ${requestId} already claimed (not on the ledger)`);
  } else {
    await claim(context, { requestId, recipient: opts.claimRecipient });
    claimed = true;
  }

  return { requestId, claimed };
}
