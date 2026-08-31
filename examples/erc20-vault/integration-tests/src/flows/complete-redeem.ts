// Settle side of the redeem flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit the output selects (completeRedeem mints the
// attested USDC assets, refundRedeem re-mints the surrendered shares).
import { VAULT_REDEEM_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import {
  deserializeEvmOutput,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";

import { REDEEM_OUTPUT_SCHEMA, REDEEM_RESPOND_SCHEMA } from "../evm-stata.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";

const MINUTE = 60_000;

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
 * `completeRedeem` for attested assets (mints the USDC), `refundRedeem` for
 * the fixed MPC failure output (re-mints the surrendered shares).
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
    const r = await context.vault.callTx.refundRedeem(
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
