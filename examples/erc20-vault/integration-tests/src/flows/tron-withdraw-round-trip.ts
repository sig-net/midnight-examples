import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_WITHDRAW_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { withTronBlockPusher } from "../tron-block-pusher.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastTron } from "./broadcast-tron.ts";
import { settleTronWithdraw } from "./complete-tron-withdraw.ts";
import {
  pollTronRespondBidirectional,
  TronExpectedOutput,
} from "./poll-tron-respond-bidirectional.ts";
import { pollTronSignedTransaction } from "./poll-tron-signature-response.ts";
import type { RespondOutcome } from "./respond-output.ts";
import { startTronWithdraw, type StartTronWithdrawOptions } from "./start-tron-withdraw.ts";

/** Options for {@link runTronWithdrawRoundTrip}. */
export interface TronWithdrawRoundTripOptions extends StartTronWithdrawOptions {
  /** Resume from a sent request instead of starting one. */
  readonly reuseRequestId?: RequestIdHex;
}

/** What {@link runTronWithdrawRoundTrip} did. */
export interface TronWithdrawRoundTripResult {
  readonly requestId: RequestIdHex;
  readonly outcome: RespondOutcome;
  /** Whether this run settled the request (false when it was already settled). */
  readonly settled: boolean;
}

/**
 * Start a Tron withdrawal, broadcast the MPC-signed transfer, wait for the MPC's
 * attestation and settle it: the whole withdraw as a client runs it.
 *
 * @param session - The flow file's shared session
 * @param tron - The Tron context
 * @param opts - The withdraw arguments and an optional resume id
 * @returns The request id, the attested outcome and whether this run settled it
 * @throws {Error} If any leg times out or the node refuses the broadcast
 */
export async function runTronWithdrawRoundTrip(
  session: VaultSession,
  tron: TronContext,
  opts: TronWithdrawRoundTripOptions,
): Promise<TronWithdrawRoundTripResult> {
  const context = await session.vaultContext();
  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("Tron withdraw", `resuming Tron withdraw round trip from ${requestId}`);
  } else {
    requestId = await startTronWithdraw(context, tron, opts);
  }

  const outcome = await withTronBlockPusher(tron.tronRpcUrl, tron.funder, async () => {
    const signed = await pollTronSignedTransaction(context, {
      requestId,
      requestsPath: VAULT_TRON_WITHDRAW_REQUESTS_PATH,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
      mpcRootPublicKey: tron.mpcRootPublicKey,
    });
    await broadcastTron(tron, { ...signed, timeoutMs: POLL_TIMEOUT_MS });
    return pollTronRespondBidirectional(context, tron, {
      requestId,
      requestsPath: VAULT_TRON_WITHDRAW_REQUESTS_PATH,
      expectedOutput: TronExpectedOutput.TransferResult,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
    });
  });

  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.bidirectionalTronWithdrawMap.member(requestIdBytes(requestId))) {
    logSkip("completeTronWithdraw", `request ${requestId} already settled`);
    return { requestId, outcome, settled: false };
  }
  await settleTronWithdraw(context, outcome);
  return { requestId, outcome, settled: true };
}
