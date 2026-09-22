// The full supply journey as one arrange-stage helper: approve the wrapper, startSupply, MPC
// signature, broadcast, completeSupply.
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_SUPPLY_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { getTransactionNonce, logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultSession } from "../vault-session.ts";
import { ensureStataApproved } from "./approve-stata.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollSupplyOutcome, settleSupply } from "./complete-supply.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startSupply } from "./start-supply.ts";

/** Options for {@link runSupplyRoundTrip}. */
export interface SupplyRoundTripOptions {
  readonly amount: bigint;
  /**
   * Resume from an existing request instead of calling {@link startSupply}, for
   * recovering a run that died mid-round-trip (e.g. the proof server OOM-killed at
   * the settle). Every later leg is naturally idempotent: the signature response and
   * attestation persist on the signet ledger, `broadcastEvm` short-circuits on a mined
   * wrapper deposit, and an already-settled request skips the settle.
   */
  readonly reuseRequestId?: RequestIdHex;
}

/** What {@link runSupplyRoundTrip} hands back to the flow file. */
export interface SupplyRoundTripResult {
  /** The supply request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /** The attested stataUSDC shares minted (0 on refund). */
  readonly shares: bigint;
  /** Whether the MPC attested the supply as failed, so the settle refunded the underlying. */
  readonly refunded: boolean;
  /**
   * Whether THIS run executed the settle. `false` means the request was
   * already settled by a prior run (rerun against a kept contract address):
   * the mint happened back then, so effects like a balance delta are not
   * observable in this run.
   */
  readonly settled: boolean;
}

/**
 * Full supply round trip against the live stack: ensure the wrapper is approved to pull the
 * underlying, submit the supply (vault-signed), poll the MPC signature, broadcast the deposit
 * tx, poll the attestation, and settle (completeSupply mints the attested stataUSDC shares).
 * The setup pipeline verifies the stataUSDC wrapper is deployed on the fork before any flow runs.
 * Requires the caller to already HOLD `amount` of the underlying vault coin (run a deposit of the
 * underlying first). Rerun-tolerant against kept addresses: an already-settled request logs a
 * skip instead of failing.
 *
 * @param session - The vault session.
 * @param opts - Supply parameters (amount of the underlying to supply) and optional resume id.
 * @returns The request id, shares minted, refund flag, and whether this run executed the settle.
 * @throws {Error} If any leg times out, or the resume id is not a request id.
 */
export async function runSupplyRoundTrip(
  session: VaultSession,
  opts: SupplyRoundTripOptions,
): Promise<SupplyRoundTripResult> {
  const context = await session.vaultContext();

  await ensureStataApproved(session);

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("supply", `resuming supply round trip from existing request ${requestId}`);
  } else {
    const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
    requestId = await startSupply(context, { amount: opts.amount, evmNonce });
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`supply request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // The deposit tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert is a valid outcome the MPC attests as a failure and completeSupply settles
  // via refund, not a broadcast error.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const outcome = await pollSupplyOutcome(context, { requestId });

  // Rerun against a kept contract address: a prior run may have already
  // settled this request (settling consumes its pending-supply marker): the
  // minted coin is already in the wallet, so skip instead of failing.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.supplySettleViews.member(requestIdBytes(requestId))) {
    logSkip("completeSupply", `supply ${requestId} already settled (no pending marker)`);
    return {
      requestId,
      shares: outcome.shares,
      refunded: outcome.matchedFailureOutput,
      settled: false,
    };
  }
  const { shares, refunded } = await settleSupply(context, requestId, outcome);
  return { requestId, shares, refunded, settled: true };
}
