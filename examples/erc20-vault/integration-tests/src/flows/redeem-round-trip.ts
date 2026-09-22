// The full redeem journey as one arrange-stage helper: startRedeem, MPC signature, broadcast,
// completeRedeem. No approve is needed: the vault redeems its OWN shares (owner = vault).
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_REDEEM_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { getTransactionNonce, logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollRedeemOutcome, settleRedeem } from "./complete-redeem.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startRedeem } from "./start-redeem.ts";

/** Options for {@link runRedeemRoundTrip}. */
export interface RedeemRoundTripOptions {
  readonly shares: bigint;
  /**
   * Resume from an existing request instead of calling {@link startRedeem}, for
   * recovering a run that died mid-round-trip (e.g. the proof server OOM-killed at
   * the settle). Every later leg is naturally idempotent: the signature response and
   * attestation persist on the signet ledger, `broadcastEvm` short-circuits on a mined
   * wrapper redeem, and an already-settled request skips the settle.
   */
  readonly reuseRequestId?: RequestIdHex;
}

/** What {@link runRedeemRoundTrip} hands back to the flow file. */
export interface RedeemRoundTripResult {
  /** The redeem request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /** The attested USDC assets minted (0 on refund). */
  readonly assets: bigint;
  /** Whether the MPC attested the redeem as failed, so the settle refunded the shares. */
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
 * Full redeem round trip against the live stack: submit the redeem (vault-signed), poll the MPC
 * signature, broadcast the redeem tx, poll the attestation, and settle (completeRedeem mints the
 * attested USDC). The setup pipeline verifies the stataUSDC wrapper is deployed on the fork before
 * any flow runs. Requires the caller to already HOLD `shares` of the stataUSDC vault coin (run a
 * supply first). Rerun-tolerant against kept addresses: an already-settled request logs a skip
 * instead of failing.
 *
 * @param session - The vault session.
 * @param opts - Redeem parameters (shares of stataUSDC to redeem) and optional resume id.
 * @returns The request id, assets minted, refund flag, and whether this run executed the settle.
 * @throws {Error} If any leg times out, or the resume id is not a request id.
 */
export async function runRedeemRoundTrip(
  session: VaultSession,
  opts: RedeemRoundTripOptions,
): Promise<RedeemRoundTripResult> {
  const context = await session.vaultContext();

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("redeem", `resuming redeem round trip from existing request ${requestId}`);
  } else {
    const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
    requestId = await startRedeem(context, { shares: opts.shares, evmNonce });
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`redeem request id is not 64-char lowercase hex: "${requestId}"`);
  }

  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_REDEEM_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const outcome = await pollRedeemOutcome(context, { requestId });

  // Rerun against a kept contract address: a prior run may have already
  // settled this request (settling consumes its pending-redeem marker): the
  // minted coin is already in the wallet, so skip instead of failing.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.redeemSettleViews.member(requestIdBytes(requestId))) {
    logSkip("completeRedeem", `redeem ${requestId} already settled (no pending marker)`);
    return {
      requestId,
      assets: outcome.assets,
      refunded: outcome.matchedFailureOutput,
      settled: false,
    };
  }
  const { assets, refunded } = await settleRedeem(context, requestId, outcome);
  return { requestId, assets, refunded, settled: true };
}
