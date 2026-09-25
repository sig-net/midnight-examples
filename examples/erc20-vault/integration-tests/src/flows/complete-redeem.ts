// Settle side of the redeem flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit its verified output kind selects
// (completeRedeem mints the attested USDC assets, refundRedeem re-mints the surrendered shares).
import {
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import { AAVE_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { VAULT_REDEEM_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { logTokenAmount } from "../evm-logging.ts";
import { REDEEM_OUTPUT_SCHEMA, REDEEM_RESPOND_SCHEMA } from "../evm-stata.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  type AttestedExecutionSpec,
  pollAttestedExecution,
  type PollAttestedExecutionOptions,
} from "./attested-execution.ts";

/**
 * The resolved attested outcome of a redeem: the verified event (its `outputKind` the MPC's
 * verdict), the bytes it signs, and the assets they carry (0 under a failure kind).
 */
export interface RedeemOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
}

// The redeem's contribution to the shared attestation poll: the wrapper's redeem returns a
// uint256 asset amount, which the MPC attests re-packed as uint64.
const REDEEM_EXECUTION: AttestedExecutionSpec = {
  label: "redeem",
  requestsPath: VAULT_REDEEM_REQUESTS_PATH,
  outputSchema: REDEEM_OUTPUT_SCHEMA,
  respondSchema: REDEEM_RESPOND_SCHEMA,
  amountOf: (decoded) => (decoded as { assets: bigint }).assets,
};

/**
 * Poll until the MPC posts a signature-verified attestation for the redeem
 * ({@link pollAttestedExecution} over the redeem request map).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested assets minted, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollRedeemOutcome(
  context: VaultContext,
  options: PollAttestedExecutionOptions,
): Promise<RedeemOutcome> {
  const { event, serializedOutput, amount } = await pollAttestedExecution(
    context,
    REDEEM_EXECUTION,
    options,
  );
  return { event, serializedOutput, assets: amount };
}

/**
 * Settle a resolved redeem outcome through the circuit its verified kind selects:
 * `completeRedeem` for an executed attestation (mints the USDC assets), `refundRedeem` for a
 * failed or unviable one (re-mints the surrendered shares). Both consume the request the event
 * names.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRedeemOutcome}.
 * @returns The attested assets minted (0 on refund) and whether the redeem was refunded.
 */
export async function settleRedeem(
  context: VaultContext,
  outcome: RedeemOutcome,
): Promise<{ assets: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.event.outputKind !== OutputKind.executed) {
    console.log(
      `redeem tx never executed (${OutputKind[outcome.event.outputKind]}): refunding the shares to this wallet`,
    );
    const r = await context.vault.callTx.refundRedeem(
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { assets: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeRedeem(
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(
    `completeRedeem settled ${requestIdHex(outcome.event.requestId)} in tx ${r.public.txId}`,
  );
  await logTokenAmount(
    context.evmRpcUrl,
    AAVE_USDC,
    context.evmVaultAddress,
    outcome.assets,
    "minted assets",
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
  return settleRedeem(context, outcome);
}
