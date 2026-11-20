// Settle side of the Tron withdraw flow: queue the MPC's attestation of the vault's
// transfer, flush it, then settle through `completeTronWithdraw` with the request id, the
// output bytes the attestation commits to, and a fresh RANDOM mint nonce so a re-minted
// coin cannot be linked back to the request.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_TRON_WITHDRAW_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollTronRespondBidirectional } from "./poll-tron-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * Settle a resolved Tron withdraw outcome: {@link queueAndFlushAttestation}, then
 * `completeTronWithdraw` with the request id, the output bytes (one zero byte for a failed
 * or unviable transfer, whose output the circuit ignores) and a random mint nonce. A
 * transfer that succeeded (true, or false for the vault's USDT) only closes the request.
 * Any other verdict re-mints the surrendered amount to this wallet, which must be the
 * withdrawer's.
 *
 * @param context - The flow context
 * @param outcome - The attested outcome from {@link pollTronRespondBidirectional}
 */
export async function settleTronWithdraw(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    outcome.succeeded
      ? "Tron transfer succeeded: completeTronWithdraw closes the request"
      : `the MPC attested the Tron transfer as ` +
          `${outcome.event.outputKind === OutputKind.executed ? "not transferring" : OutputKind[outcome.event.outputKind]}: ` +
          "completeTronWithdraw re-mints the surrendered amount to this wallet (the withdrawer)",
  );
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput =
    outcome.event.outputKind === OutputKind.executed ? outcome.serializedOutput : new Uint8Array(1);
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const result = await context.vault.callTx.completeTronWithdraw(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeTronWithdraw settled in tx ${result.public.txId}`);
}

/** Options for {@link completeTronWithdraw}. */
export interface CompleteTronWithdrawOptions {
  /** The Tron withdraw request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the Tron withdrawal's attestation resolves, then settle it.
 *
 * @param context - The flow context
 * @param tron - The Tron context the transfer's receipt is read through
 * @param options - The request id to settle
 * @throws {Error} If no verifying attestation posts within the poll's deadline
 */
export async function completeTronWithdraw(
  context: VaultContext,
  tron: TronContext,
  options: CompleteTronWithdrawOptions,
): Promise<void> {
  const outcome = await pollTronRespondBidirectional(context, tron, {
    requestId: options.requestId,
    requestsPath: VAULT_TRON_WITHDRAW_REQUESTS_PATH,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleTronWithdraw(context, outcome);
}
