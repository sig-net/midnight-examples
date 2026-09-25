// Settle side of the supply flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit its verified output kind selects
// (completeSupply mints the attested stataUSDC shares, refundSupply re-mints the surrendered
// underlying).
import {
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import { STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { VAULT_SUPPLY_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { logTokenAmount } from "../evm-logging.ts";
import { SUPPLY_OUTPUT_SCHEMA, SUPPLY_RESPOND_SCHEMA } from "../evm-stata.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  type AttestedExecutionSpec,
  pollAttestedExecution,
  type PollAttestedExecutionOptions,
} from "./attested-execution.ts";

/**
 * The resolved attested outcome of a supply: the verified event (its `outputKind` the MPC's
 * verdict), the bytes it signs, and the shares they carry (0 under a failure kind).
 */
export interface SupplyOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly shares: bigint;
}

// The supply's contribution to the shared attestation poll: the wrapper's deposit returns a
// uint256 share count, which the MPC attests re-packed as uint64.
const SUPPLY_EXECUTION: AttestedExecutionSpec = {
  label: "supply",
  requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  outputSchema: SUPPLY_OUTPUT_SCHEMA,
  respondSchema: SUPPLY_RESPOND_SCHEMA,
  amountOf: (decoded) => (decoded as { shares: bigint }).shares,
};

/**
 * Poll until the MPC posts a signature-verified attestation for the supply
 * ({@link pollAttestedExecution} over the supply request map).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested shares minted, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollSupplyOutcome(
  context: VaultContext,
  options: PollAttestedExecutionOptions,
): Promise<SupplyOutcome> {
  const { event, serializedOutput, amount } = await pollAttestedExecution(
    context,
    SUPPLY_EXECUTION,
    options,
  );
  return { event, serializedOutput, shares: amount };
}

/**
 * Settle a resolved supply outcome through the circuit its verified kind selects:
 * `completeSupply` for an executed attestation (mints the stataUSDC shares), `refundSupply`
 * for a failed or unviable one (re-mints the surrendered underlying). Both consume the request
 * the event names.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollSupplyOutcome}.
 * @returns The attested shares minted (0 on refund) and whether the supply was refunded.
 */
export async function settleSupply(
  context: VaultContext,
  outcome: SupplyOutcome,
): Promise<{ shares: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.event.outputKind !== OutputKind.executed) {
    console.log(
      `supply tx never executed (${OutputKind[outcome.event.outputKind]}): refunding the underlying to this wallet`,
    );
    const r = await context.vault.callTx.refundSupply(
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { shares: 0n, refunded: true };
  }
  const r = await context.vault.callTx.completeSupply(
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
  );
  console.log(
    `completeSupply settled ${requestIdHex(outcome.event.requestId)} in tx ${r.public.txId}`,
  );
  await logTokenAmount(
    context.evmRpcUrl,
    STATA_USDC,
    context.evmVaultAddress,
    outcome.shares,
    "minted shares",
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
  return settleSupply(context, outcome);
}
