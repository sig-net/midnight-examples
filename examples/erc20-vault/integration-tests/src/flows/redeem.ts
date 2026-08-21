// `redeem`: record a stataToken.redeem(shares, vault, vault) SignBidirectionalEvent on the
// vault's REDEEM ledger map, surrendering `shares` of the stataUSDC vault coin (burned), to be
// signed with the VAULT's account and broadcast. On success completeRedeem mints the attested
// USDC assets (principal + accrued interest); on EVM failure refund re-mints the shares. Mirrors
// the supply flow with a redeem-schema (uint64 assets) attestation. No approve is needed: the
// vault redeems its OWN shares (owner = vault). Runs only where the stataToken is deployed.
import { VAULT_REDEEM_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
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
  REDEEM_MPC_ROUTING,
  REDEEM_OUTPUT_SCHEMA,
  REDEEM_RESPOND_SCHEMA,
  STATA_GAS_LIMIT,
  STATA_MAX_FEE_PER_GAS,
  STATA_MAX_PRIORITY_FEE_PER_GAS,
  STATA_REDEEM_SELECTOR,
  STATA_USDC,
  stataAvailable,
} from "../evm-stata.ts";
import { evmAddressBytes } from "../evm-transfer.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";
import type { VaultSession } from "../vault-session.ts";
import { vaultTokenType } from "../vault-token.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";

const MINUTE = 60_000;
const VAULT_PATH = asciiPadded("vault", PATH_BYTES);

/** Options for {@link redeem}. */
export interface RedeemOptions {
  readonly shares: bigint;
  readonly evmNonce: bigint;
}

/**
 * Record the redeem request (stataToken.redeem(shares, vault, vault)) and return its id. The
 * burned coin is the stataUSDC vault token of exactly `shares`.
 *
 * @param context - The flow context.
 * @param options - The redeem parameters (shares, evmNonce).
 * @returns The recorded redeem request id.
 */
export async function redeem(context: VaultContext, options: RedeemOptions): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialized)
    throw new Error("vault is not initialized, run the initialize flow first");

  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(vaultTokenType(STATA_USDC, context.vaultContractAddress)),
    value: options.shares,
  };

  const vault = evmAddressBytes(context.evmVaultAddress);
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    requestNonce: before.signetRequestNonce,
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH,
    ...REDEEM_MPC_ROUTING,
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
          selector: STATA_REDEEM_SELECTOR,
          noWords: 3n,
          words: [
            numericAbiWord(options.shares),
            evmAddressAbiWord(vault),
            evmAddressAbiWord(vault),
          ],
        },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.redeem(
    options.evmNonce,
    SIGNET_DEFAULT_KEY_VERSION,
    options.shares,
    coin,
  );
  console.log(`redeem finalized in tx ${result.public.txId}`);

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
  return expectedIdHex;
}

/** The resolved attested outcome of a redeem (uint64 assets minted, or the failure output). */
export interface RedeemOutcome {
  readonly event: Awaited<ReturnType<SignetReader["getRespondBidirectionalEvents"]>>[number];
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
  readonly matchedFailureOutput: boolean;
}
type SignetReader = ReturnType<typeof createResponseReader>;

/**
 * Resolve the MPC's attested redeem outcome by signature verification (the redeem-schema twin of
 * fetchSupplyOutcome).
 *
 * @param context - The flow context.
 * @param requestId - The redeem request id to resolve.
 * @returns The resolved outcome (attested assets, or the failure output), or undefined.
 */
async function fetchRedeemOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<RedeemOutcome | undefined> {
  const reader = createResponseReader(context, VAULT_REDEEM_REQUESTS_PATH);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;

  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const cached = await fetchFakenetResponse(requestId, 3_000).catch(() => undefined);
  const candidates: { serializedOutput: Uint8Array; assets: bigint; isFailureOutput: boolean }[] =
    [];
  if (cached?.success && cached.output != null) {
    try {
      const decoded = deserializeEvmOutput(REDEEM_OUTPUT_SCHEMA, cached.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(REDEEM_RESPOND_SCHEMA, decoded),
        assets: (decoded as { assets: bigint }).assets,
        isFailureOutput: false,
      });
    } catch {
      /* only the failure candidate can match */
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, assets: 0n, isFailureOutput: true });

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
        assets: c.assets,
        matchedFailureOutput: c.isFailureOutput,
      };
    }
  }
  return undefined;
}

/** Options for {@link pollRedeemOutcome}. */
export interface PollRedeemOutcomeOptions {
  /** The redeem request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; 6 minutes when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the redeem
 * (see {@link fetchRedeemOutcome} for candidate resolution).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested assets minted, or the failure output).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollRedeemOutcome(
  context: VaultContext,
  options: PollRedeemOutcomeOptions,
): Promise<RedeemOutcome> {
  const end = Date.now() + (options.timeoutMs ?? 6 * MINUTE);
  let outcome: RedeemOutcome | undefined;
  while (
    Date.now() < end &&
    (outcome = await fetchRedeemOutcome(context, options.requestId)) === undefined
  ) {
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  if (!outcome)
    throw new Error(`timed out waiting for a redeem attestation for ${options.requestId}`);
  return outcome;
}

/**
 * Settle a resolved redeem outcome through the circuit its content selects:
 * `completeRedeem` for attested assets (mints the USDC), `refund` for the
 * fixed MPC failure output (re-mints the surrendered shares).
 *
 * @param context - The flow context.
 * @param requestId - The redeem request id being settled.
 * @param outcome - The attested outcome from {@link pollRedeemOutcome}.
 * @returns The attested assets minted (0 on refund) and whether the redeem was refunded.
 */
export async function settleRedeem(
  context: VaultContext,
  requestId: RequestIdHex,
  outcome: RedeemOutcome,
): Promise<{ assets: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.matchedFailureOutput) {
    console.log("redeem tx never executed: refunding the shares to this wallet");
    const r = await context.vault.callTx.refund(
      requestIdBytes(requestId),
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { assets: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeRedeem(
    requestIdBytes(requestId),
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(
    `completeRedeem settled in tx ${r.public.txId} (minted ${String(outcome.assets)} USDC)`,
  );
  return { assets: outcome.assets, refunded: false };
}

/**
 * Poll until the redeem outcome resolves, then settle: {@link pollRedeemOutcome}
 * followed by {@link settleRedeem}.
 *
 * @param context - The flow context.
 * @param requestId - The redeem request id to settle.
 * @returns The attested assets minted (0 on refund) and whether the redeem was refunded.
 */
export async function completeRedeem(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<{ assets: bigint; refunded: boolean }> {
  const outcome = await pollRedeemOutcome(context, { requestId });
  return settleRedeem(context, requestId, outcome);
}

/** Options for {@link runRedeemRoundTrip}. */
export interface RedeemRoundTripOptions {
  readonly shares: bigint;
}

/**
 * Full redeem round trip against the live stack: submit the redeem (vault-signed), poll the MPC
 * signature, broadcast the redeem tx, poll the attestation, and settle (completeRedeem mints the
 * attested USDC). Gated on the stataToken being deployed; logSkip otherwise. Requires the caller
 * to already HOLD `shares` of the stataUSDC vault coin (run a supply first).
 *
 * @param session - The vault session.
 * @param opts - Redeem parameters (shares of stataUSDC to redeem).
 * @returns The request id, assets minted, and refund flag — or undefined when skipped.
 */
export async function runRedeemRoundTrip(
  session: VaultSession,
  opts: RedeemRoundTripOptions,
): Promise<{ requestId: RequestIdHex; assets: bigint; refunded: boolean } | undefined> {
  const context = await session.vaultContext();
  if (!(await stataAvailable(context.evmRpcUrl))) {
    logSkip(
      "redeem",
      "stataToken not deployed on this EVM chain (needs Sepolia or a Sepolia fork)",
    );
    return undefined;
  }

  const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
  const requestId = await redeem(context, { shares: opts.shares, evmNonce });

  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_REDEEM_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const { assets, refunded } = await completeRedeem(context, requestId);
  return { requestId, assets, refunded };
}
