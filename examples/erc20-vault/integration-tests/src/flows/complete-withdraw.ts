// Settle side of the withdraw flow: route the MPC's attested outcome on its
// verified output kind, an executed transfer to `completeWithdraw` and a
// failed or unviable one to `refundWithdraw`, handing each the event in
// circuit-input form, the output bytes its signature verified over, and a
// fresh RANDOM mint nonce so a re-minted coin cannot be linked to the request.

import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { respondBidirectionalEventToCircuitInput } from "@sig-net/midnight";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved withdraw outcome through the circuit its verified kind
 * selects: `completeWithdraw` for an executed transfer, `refundWithdraw` for
 * a failed or unviable one. This caller supplies the event in circuit-input
 * form, the output bytes its signature verified over, and a random mint
 * nonce. Every re-mint (a refund, or an executed transfer that returned
 * false) goes to this wallet, which must therefore be the withdrawer's. An
 * executed transfer that returned true settles from any wallet. The coin
 * handling is midnight-js's job: the callTx balances the resulting offer
 * like any other call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from
 *   {@link file://./poll-respond-bidirectional.ts pollRespondBidirectional}.
 * @throws {Error} If the withdrawal was already settled (no pending marker on
 *   the ledger), or this wallet is not the withdrawer on a refund route.
 */
export async function settleWithdraw(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);

  // A fresh random mint nonce per settle: on the refund paths the circuit
  // threads it into the shielded re-mint verbatim, so randomness HERE is what
  // keeps the refunded coin unlinkable to the (public) request id. The
  // success branch mints nothing and ignores it.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  if (outcome.event.outputKind !== OutputKind.executed) {
    console.log(
      `EVM transfer never executed (${OutputKind[outcome.event.outputKind]}): refunding to this wallet (the withdrawer)`,
    );
    const result = await context.vault.callTx.refundWithdraw(
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refundWithdraw settled in tx ${result.public.txId}`);
    return;
  }

  console.log(
    outcome.succeeded
      ? "EVM transfer succeeded: settling final"
      : "EVM transfer returned false: settling with a refund to this wallet (the withdrawer)",
  );
  const result = await context.vault.callTx.completeWithdraw(
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The withdraw request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the withdrawal's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the shared request map followed by
 * {@link settleWithdraw}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline, plus whatever {@link settleWithdraw} throws.
 */
export async function completeWithdraw(
  context: VaultContext,
  options: CompleteWithdrawOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleWithdraw(context, outcome);
}
