// Settle side of the supply flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit the output selects (completeSupply mints the
// attested stataUSDC shares, refundSupply re-mints the surrendered underlying).
import { VAULT_SUPPLY_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import {
  deserializeEvmOutput,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";

import { SUPPLY_OUTPUT_SCHEMA, SUPPLY_RESPOND_SCHEMA } from "../evm-stata.ts";
import { fetchFakenetResponse } from "../fakenet-responses.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { readVaultLedger } from "../vault-ledger.ts";

const MINUTE = 60_000;

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
 * `completeSupply` for attested shares (mints the stataUSDC), `refundSupply`
 * for the fixed MPC failure output (re-mints the surrendered underlying).
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
    const r = await context.vault.callTx.refundSupply(
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
