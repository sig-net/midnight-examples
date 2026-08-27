// `supply`: record a stataToken.deposit(amount, vault) SignBidirectionalEvent on the vault's
// SUPPLY ledger map, surrendering `amount` of the underlying (USDC) vault coin (burned), to be
// signed with the VAULT's account and broadcast. On success completeSupply mints the attested
// stataUSDC shares; on EVM failure refund re-mints the surrendered amount. Mirrors the swap flow
// with a supply-schema (uint64 shares) attestation. Exact-input, so there is no change. Runs
// only where the stataToken is deployed (Sepolia / a Sepolia fork); logSkip elsewhere.
import { VAULT_SUPPLY_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import { getTransactionNonce, logSkip } from "@midnight-examples/test-harness";
import {
  asciiPadded,
  calculateRequestId,
  deserializeEvmOutput,
  evmAddressAbiWord,
  hexToBytes,
  MPC_FAILURE_OUTPUT,
  numericAbiWord,
  PATH_BYTES,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  TxParamType,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";

import {
  AAVE_USDC,
  STATA_DEPOSIT_SELECTOR,
  STATA_GAS_LIMIT,
  STATA_MAX_FEE_PER_GAS,
  STATA_MAX_PRIORITY_FEE_PER_GAS,
  STATA_USDC,
  stataAvailable,
  SUPPLY_MPC_ROUTING,
  SUPPLY_OUTPUT_SCHEMA,
  SUPPLY_RESPOND_SCHEMA,
} from "../evm-stata.ts";
import { evmAddressBytes } from "../evm-transfer.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import type { VaultSession } from "../vault-session.ts";
import { vaultTokenType } from "../vault-token.ts";
import { ensureStataApproved } from "./approve-stata.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;
const VAULT_PATH = asciiPadded("vault", PATH_BYTES);

/** Options for {@link supply}. */
export interface SupplyOptions {
  readonly amount: bigint;
  readonly evmNonce: bigint;
}

/**
 * Record the supply request (stataToken.deposit(amount, vault)) and return its id. The burned
 * coin is the underlying (USDC) vault token of exactly `amount`.
 *
 * @param context - The flow context.
 * @param options - The supply parameters (amount, evmNonce).
 * @returns The recorded supply request id.
 */
export async function supply(context: VaultContext, options: SupplyOptions): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialized)
    throw new Error("vault is not initialized, run the initialize flow first");

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(AAVE_USDC, context.vaultContractAddress)),
    value: options.amount,
  };

  // The record the contract composes: vault path/sender, stataToken `to`, contract-fixed gas,
  // deposit(amount, receiver=vault).
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH,
    ...SUPPLY_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    caip2Id: before.caip2Id,
    txParams: {
      to: evmAddressBytes(STATA_USDC),
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit: STATA_GAS_LIMIT,
      maxFeePerGas: STATA_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: STATA_MAX_PRIORITY_FEE_PER_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: STATA_DEPOSIT_SELECTOR,
          noWords: 2n,
          words: [
            numericAbiWord(options.amount),
            evmAddressAbiWord(evmAddressBytes(context.evmVaultAddress)),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.supply(
    options.evmNonce,
    SIGNET_DEFAULT_KEY_VERSION,
    options.amount,
    coin,
  );
  console.log(`supply finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!toSignBidirectionalEventIndex(after.supplyEventMap).has(expectedIdHex)) {
    throw new Error(
      `recomputed supply request id ${expectedIdHex} not found on the supply ledger map`,
    );
  }
  console.log(`supply request id: ${expectedIdHex}`);
  return expectedIdHex;
}

/** The resolved attested outcome of a supply (uint64 shares minted, or the failure output). */
export interface SupplyOutcome {
  readonly event: Awaited<ReturnType<SignetReader["getRespondBidirectionalEvents"]>>[number];
  readonly serializedOutput: Uint8Array;
  readonly shares: bigint;
  readonly matchedFailureOutput: boolean;
}
type SignetReader = ReturnType<typeof createResponseReader>;

/**
 * Resolve the MPC's attested supply outcome by signature verification (the supply-schema twin of
 * fetchSwapOutcome): the success candidate is the fakenet's cached traced output decoded per the
 * uint256 output schema and re-packed per the uint64 respond schema; the failure candidate is the
 * protocol's fixed 5-byte output. Selected only when a posted event's ECDSA signature verifies
 * over it against the vault-pinned response key.
 *
 * @param context - The flow context.
 * @param requestId - The supply request id to resolve.
 * @returns The resolved outcome (attested shares, or the failure output), or undefined.
 */
async function fetchSupplyOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<SupplyOutcome | undefined> {
  const reader = createResponseReader(context, VAULT_SUPPLY_REQUESTS_PATH);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;

  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const cached = await fetchFakenetResponse(requestId, 3_000).catch(() => undefined);
  const candidates: { serializedOutput: Uint8Array; shares: bigint; isFailureOutput: boolean }[] =
    [];
  if (cached?.success && cached.output != null) {
    try {
      const decoded = deserializeEvmOutput(SUPPLY_OUTPUT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(SUPPLY_RESPOND_SCHEMA, decoded),
        shares: (decoded as { shares: bigint }).shares,
        isFailureOutput: false,
      });
    } catch {
      /* only the failure candidate can match */
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, shares: 0n, isFailureOutput: true });

  for (const c of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        c.serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    if (event) {
      return {
        event,
        serializedOutput: c.serializedOutput,
        shares: c.shares,
        matchedFailureOutput: c.isFailureOutput,
      };
    }
  }
  return undefined;
}

/** Options for {@link pollSupplyOutcome}. */
export interface PollSupplyOutcomeOptions {
  /** The supply request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; 6 minutes when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the supply
 * (see {@link fetchSupplyOutcome} for candidate resolution).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested shares minted, or the failure output).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollSupplyOutcome(
  context: VaultContext,
  options: PollSupplyOutcomeOptions,
): Promise<SupplyOutcome> {
  const end = Date.now() + (options.timeoutMs ?? 6 * MINUTE);
  let outcome: SupplyOutcome | undefined;
  while (
    Date.now() < end &&
    (outcome = await fetchSupplyOutcome(context, options.requestId)) === undefined
  ) {
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  if (!outcome)
    throw new Error(`timed out waiting for a supply attestation for ${options.requestId}`);
  return outcome;
}

/**
 * Settle a resolved supply outcome through the circuit its content selects:
 * `completeSupply` for attested shares (mints the stataUSDC), `refund` for
 * the fixed MPC failure output (re-mints the surrendered underlying).
 *
 * @param context - The flow context.
 * @param requestId - The supply request id being settled.
 * @param outcome - The attested outcome from {@link pollSupplyOutcome}.
 * @returns The attested shares minted (0 on refund) and whether the supply was refunded.
 */
export async function settleSupply(
  context: VaultContext,
  requestId: RequestIdHex,
  outcome: SupplyOutcome,
): Promise<{ shares: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.matchedFailureOutput) {
    console.log("supply tx never executed: refunding the underlying to this wallet");
    const r = await context.vault.callTx.refund(
      requestIdBytes(requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { shares: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeSupply(
    requestIdBytes(requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(
    `completeSupply settled in tx ${r.public.txId} (minted ${String(outcome.shares)} stataUSDC)`,
  );
  return { shares: outcome.shares, refunded: false };
}

/**
 * Poll until the supply outcome resolves, then settle: {@link pollSupplyOutcome}
 * followed by {@link settleSupply}.
 *
 * @param context - The flow context.
 * @param requestId - The supply request id to settle.
 * @returns The attested shares minted (0 on refund) and whether the supply was refunded.
 */
export async function completeSupply(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<{ shares: bigint; refunded: boolean }> {
  const outcome = await pollSupplyOutcome(context, { requestId });
  return settleSupply(context, requestId, outcome);
}

/** Options for {@link runSupplyRoundTrip}. */
export interface SupplyRoundTripOptions {
  readonly amount: bigint;
}

/**
 * Full supply round trip against the live stack: ensure the wrapper is approved to pull the
 * underlying, submit the supply (vault-signed), poll the MPC signature, broadcast the deposit
 * tx, poll the attestation, and settle (completeSupply mints the attested stataUSDC shares).
 * Gated on the stataToken being deployed; logSkip otherwise. Requires the caller to already HOLD
 * `amount` of the underlying vault coin (run a deposit of the underlying first).
 *
 * @param session - The vault session.
 * @param opts - Supply parameters (amount of the underlying to supply).
 * @returns The request id, shares minted, and refund flag — or undefined when skipped.
 */
export async function runSupplyRoundTrip(
  session: VaultSession,
  opts: SupplyRoundTripOptions,
): Promise<{ requestId: RequestIdHex; shares: bigint; refunded: boolean } | undefined> {
  const context = await session.vaultContext();
  if (!(await stataAvailable(context.evmRpcUrl))) {
    logSkip(
      "supply",
      "stataToken not deployed on this EVM chain (needs Sepolia or a Sepolia fork)",
    );
    return undefined;
  }

  await ensureStataApproved(session);

  const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
  const requestId = await supply(context, { amount: opts.amount, evmNonce });

  // The deposit tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert is a valid outcome the MPC attests as a failure and completeSupply settles
  // via refund, not a broadcast error.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const { shares, refunded } = await completeSupply(context, requestId);
  return { requestId, shares, refunded };
}
