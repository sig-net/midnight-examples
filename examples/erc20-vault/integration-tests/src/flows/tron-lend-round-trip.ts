// The Tron lend legs as a client runs them, each start to settle: the deployer's approval
// of the share token on the underlying, a supply of underlying coins for share coins, and a
// redeem of share coins for underlying coins. Each leg starts the request, polls the MPC's
// signature, broadcasts the vault-signed transaction, polls the MPC's attestation and
// settles it, while a block pusher keeps the local Tron chain producing blocks.
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_APPROVE_REQUESTS_PATH,
  VAULT_TRON_REDEEM_REQUESTS_PATH,
  VAULT_TRON_SUPPLY_REQUESTS_PATH,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { withTronBlockPusher } from "../tron-block-pusher.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastTron } from "./broadcast-tron.ts";
import { settleTronApprove } from "./complete-tron-approve.ts";
import { settleTronRedeem } from "./complete-tron-redeem.ts";
import { settleTronSupply } from "./complete-tron-supply.ts";
import {
  pollTronRespondBidirectional,
  TronExpectedOutput,
} from "./poll-tron-respond-bidirectional.ts";
import { pollTronSignedTransaction } from "./poll-tron-signature-response.ts";
import type { RespondOutcome } from "./respond-output.ts";
import { startTronApprove } from "./start-tron-approve.ts";
import { startTronRedeem, type StartTronRedeemOptions } from "./start-tron-redeem.ts";
import { startTronSupply, type StartTronSupplyOptions } from "./start-tron-supply.ts";
import type { TronWindowOptions } from "./tron-vault-request.ts";

/** Resuming a leg from a sent request instead of starting one. */
export interface TronLendResumeOptions {
  /** The sent request to resume. */
  readonly reuseRequestId?: RequestIdHex;
}

/** What one Tron lend leg did. */
export interface TronLendRoundTripResult {
  readonly requestId: RequestIdHex;
  readonly outcome: RespondOutcome;
  /** Whether this run settled the request (false when it was already settled). */
  readonly settled: boolean;
}

/** How one Tron lend leg reaches the MPC and settles. */
interface TronLendLeg {
  /** The leg's name in the log. */
  readonly label: string;
  /** The ledger path of the leg's request map. */
  readonly requestsPath: readonly number[];
  /** What the leg's call returns when it succeeded. */
  readonly expectedOutput: TronExpectedOutput;
  /** Whether the leg's request map still holds the request, so it is still unsettled. */
  readonly open: (state: VaultLedgerState, requestId: Uint8Array) => boolean;
  /** The leg's settle. */
  readonly settle: (context: VaultContext, outcome: RespondOutcome) => Promise<void>;
}

// Polls the MPC's signature of a sent request, broadcasts it, polls the attestation and
// settles it unless a prior run already did.
async function finishTronLendLeg(
  context: VaultContext,
  tron: TronContext,
  requestId: RequestIdHex,
  leg: TronLendLeg,
): Promise<TronLendRoundTripResult> {
  const outcome = await withTronBlockPusher(tron.tronRpcUrl, tron.funder, async () => {
    const signed = await pollTronSignedTransaction(context, {
      requestId,
      requestsPath: leg.requestsPath,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
      mpcRootPublicKey: tron.mpcRootPublicKey,
    });
    await broadcastTron(tron, { ...signed, timeoutMs: POLL_TIMEOUT_MS });
    return pollTronRespondBidirectional(context, tron, {
      requestId,
      requestsPath: leg.requestsPath,
      expectedOutput: leg.expectedOutput,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
    });
  });
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!leg.open(ledger, requestIdBytes(requestId))) {
    logSkip(leg.label, `request ${requestId} already settled`);
    return { requestId, outcome, settled: false };
  }
  await leg.settle(context, outcome);
  return { requestId, outcome, settled: true };
}

/**
 * Approve the Tron lend share token on the underlying, start to settle. The start is
 * deployer-gated, so the session's identity must be the deployer's.
 *
 * @param session - The flow file's shared session
 * @param tron - The Tron context
 * @param opts - The window options and an optional resume id
 * @returns The request id, the attested outcome and whether this run settled it
 * @throws {Error} If any leg times out or the node refuses the broadcast
 */
export async function runTronApproveRoundTrip(
  session: VaultSession,
  tron: TronContext,
  opts: TronWindowOptions & TronLendResumeOptions,
): Promise<TronLendRoundTripResult> {
  const context = await session.vaultContext();
  const requestId = opts.reuseRequestId ?? (await startTronApprove(context, tron, opts));
  return finishTronLendLeg(context, tron, requestId, {
    label: "completeTronApprove",
    requestsPath: VAULT_TRON_APPROVE_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.ApproveResult,
    open: (state, id) => state.bidirectionalTronApproveMap.member(id),
    settle: settleTronApprove,
  });
}

/**
 * Supply underlying coins for share coins, start to settle. The caller must hold the amount
 * plus the supply fee in shielded underlying coins, and the share token must hold the
 * vault's allowance.
 *
 * @param session - The flow file's shared session
 * @param tron - The Tron context
 * @param opts - The supply arguments and an optional resume id
 * @returns The request id, the attested outcome and whether this run settled it
 * @throws {Error} If any leg times out or the node refuses the broadcast
 */
export async function runTronSupplyRoundTrip(
  session: VaultSession,
  tron: TronContext,
  opts: StartTronSupplyOptions & TronLendResumeOptions,
): Promise<TronLendRoundTripResult> {
  const context = await session.vaultContext();
  const requestId = opts.reuseRequestId ?? (await startTronSupply(context, tron, opts));
  return finishTronLendLeg(context, tron, requestId, {
    label: "completeTronSupply",
    requestsPath: VAULT_TRON_SUPPLY_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.Uint256,
    open: (state, id) => state.bidirectionalTronSupplyMap.member(id),
    settle: settleTronSupply,
  });
}

/**
 * Redeem share coins for underlying coins, start to settle. The caller must hold the shares
 * plus the redeem fee in shielded share coins.
 *
 * @param session - The flow file's shared session
 * @param tron - The Tron context
 * @param opts - The redeem arguments and an optional resume id
 * @returns The request id, the attested outcome and whether this run settled it
 * @throws {Error} If any leg times out or the node refuses the broadcast
 */
export async function runTronRedeemRoundTrip(
  session: VaultSession,
  tron: TronContext,
  opts: StartTronRedeemOptions & TronLendResumeOptions,
): Promise<TronLendRoundTripResult> {
  const context = await session.vaultContext();
  const requestId = opts.reuseRequestId ?? (await startTronRedeem(context, tron, opts));
  return finishTronLendLeg(context, tron, requestId, {
    label: "completeTronRedeem",
    requestsPath: VAULT_TRON_REDEEM_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.Uint256,
    open: (state, id) => state.bidirectionalTronRedeemMap.member(id),
    settle: settleTronRedeem,
  });
}
