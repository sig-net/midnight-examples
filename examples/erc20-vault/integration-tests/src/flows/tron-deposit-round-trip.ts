import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { withTronBlockPusher } from "../tron-block-pusher.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastTron } from "./broadcast-tron.ts";
import type { ShieldedTokenRecipient } from "./complete-deposit.ts";
import { settleTronDeposit } from "./complete-tron-deposit.ts";
import { pollTronRespondBidirectional } from "./poll-tron-respond-bidirectional.ts";
import { pollTronSignedTransaction } from "./poll-tron-signature-response.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import { startTronDeposit } from "./start-tron-deposit.ts";

/** */
export interface TronDepositRoundTripOptions {
  readonly amount: bigint;
  readonly reuseRequestId?: RequestIdHex;
  readonly claimRecipient?: ShieldedTokenRecipient;
  readonly skipClaim?: boolean;
}

/** */
export interface TronDepositRoundTripResult {
  readonly requestId: RequestIdHex;
  readonly claimed: boolean;
}

/**
 * @param session - The flow file's shared session
 * @param tron - The Tron context
 * @param opts - Deposit amount and optional resume id
 * @returns The request id and whether this run executed the claim
 * @throws {Error} If any leg times out
 */
export async function runTronDepositRoundTrip(
  session: VaultSession,
  tron: TronContext,
  opts: TronDepositRoundTripOptions,
): Promise<TronDepositRoundTripResult> {
  const context = await session.vaultContext();
  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("Tron deposit", `resuming Tron deposit round trip from ${requestId}`);
  } else {
    requestId = await startTronDeposit(context, tron, { amount: opts.amount });
  }

  const outcome = await withTronBlockPusher(tron.tronRpcUrl, tron.funder, async () => {
    const signed = await pollTronSignedTransaction(context, {
      requestId,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
      expectedOwner: tron.tronUserAddress.base58,
    });
    const info = await broadcastTron(tron, { ...signed, timeoutMs: POLL_TIMEOUT_MS });
    if (info.receiptResult !== "SUCCESS") {
      throw new Error(`Tron deposit transfer ${requestId} ran ${info.receiptResult}`);
    }
    return pollTronRespondBidirectional(context, {
      requestId,
      intervalMs: 1000,
      timeoutMs: POLL_TIMEOUT_MS,
    });
  });
  if (!outcome.succeeded) {
    throw new Error(`the MPC attested Tron deposit ${requestId} as not executed`);
  }

  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const open = ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId));
  if (opts.skipClaim) {
    if (open) await queueAndFlushAttestation(context, outcome);
    logSkip("completeTronDeposit", `skipClaim set: request ${requestId} left unclaimed`);
    return { requestId, claimed: false };
  }
  if (!open) {
    logSkip("completeTronDeposit", `request ${requestId} already claimed`);
    return { requestId, claimed: false };
  }
  await settleTronDeposit(context, outcome, opts.claimRecipient);
  return { requestId, claimed: true };
}
