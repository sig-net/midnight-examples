// The full deposit journey as one arrange-stage helper: startDeposit, MPC signature,
// broadcast the sweep, MPC attestation, completeDeposit.
import { VAULT_DEPOSIT_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import { getTransactionNonce, logSkip } from "@midnight-examples/test-harness";
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";

import { readVaultLedger } from "../vault-ledger.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { settleDeposit, type ShieldedTokenRecipient } from "./complete-deposit.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startDeposit } from "./start-deposit.ts";

const MINUTE = 60_000;

/** Options for {@link runDepositRoundTrip}. */
export interface DepositRoundTripOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** The ERC20 to deposit; defaults to the suite's `ERC20_ADDRESS`. */
  readonly erc20Address?: string;
  /**
   * Resume from an existing request instead of calling {@link startDeposit} —
   * for recovering a run that died mid-round-trip (e.g. the proof server
   * OOM-killed at the claim step). Every later leg is naturally idempotent:
   * the signature response and attestation persist on the signet ledger,
   * `broadcastEvm` short-circuits on a mined sweep, and an already-claimed
   * request skips the claim.
   */
  readonly reuseRequestId?: RequestIdHex;
  /**
   * The wallet the claim mints the shielded vault tokens to; the caller's
   * own wallet when omitted. Passed through to {@link settleDeposit} —
   * only the depositor (the session wallet) may claim either way.
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
 * EVM nonce, {@link startDeposit}, poll the MPC's signature, broadcast the
 * sweep, poll the MPC's attestation, and {@link settleDeposit} — leaving
 * the claim recipient (`opts.claimRecipient`, the caller's own wallet by
 * default) holding `opts.amount` of freshly minted shielded vault tokens.
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
 * @throws {Error} If any leg times out, the MPC attests the sweep as failed, or the
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
    requestId = await startDeposit(context, {
      amount: opts.amount,
      evmNonce,
      erc20Address: opts.erc20Address,
    });
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
    requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
  });

  // Idempotent: an already-mined sweep short-circuits; a reverted or
  // nonce-burned sweep throws — either would starve the claim, so let it.
  await broadcastEvm(context, { transaction: signedSweepTransaction });

  const outcome = await pollRespondBidirectional(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
  });
  // This helper arranges a SUCCESSFUL deposit — a failure attestation means
  // the sweep did not land and the claim below could never mint.
  if (!outcome.succeeded) {
    throw new Error(
      `the MPC attested deposit sweep ${requestId} as FAILED — ` +
        `the sweep broadcast above mined, so the responder saw a different outcome (stale responder config?)`,
    );
  }

  let claimed = false;
  if (opts.skipClaim) {
    logSkip("completeDeposit", `skipClaim set: request ${requestId} left unclaimed on the ledger`);
    return { requestId, claimed };
  }

  // Rerun against a kept contract address: a prior run may have already
  // claimed this request (claiming consumes it from the ledger) — the minted
  // tokens are already in the wallet, so skip instead of failing.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.depositEventMap.member(requestIdBytes(requestId))) {
    logSkip("completeDeposit", `request ${requestId} already claimed (not in the deposit map)`);
  } else {
    await settleDeposit(context, requestId, outcome, opts.claimRecipient);
    claimed = true;
  }

  return { requestId, claimed };
}
