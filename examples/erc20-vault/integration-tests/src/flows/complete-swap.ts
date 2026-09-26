// Settle side of the swap flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit its verified output kind selects (completeSwap
// mints the exact amountOut of tokenOut plus the unspent tokenIn as change, refundSwap re-mints
// the surrendered amountInMaximum).
import {
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import { VAULT_SWAP_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { logTokenAmount } from "../evm-logging.ts";
import { SWAP_OUTPUT_SCHEMA, SWAP_RESPOND_SCHEMA } from "../evm-swap.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  type AttestedExecutionSpec,
  pollAttestedExecution,
  type PollAttestedExecutionOptions,
} from "./attested-execution.ts";

/**
 * The resolved attested outcome of a swap: the verified event (its `outputKind` the MPC's
 * verdict), the bytes it signs, and the amountIn they carry (0 under a failure kind).
 */
export interface SwapOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly amountIn: bigint;
}

// The swap's contribution to the shared attestation poll: exactOutputSingle returns a uint256
// amountIn, which the MPC attests re-packed as uint64 (the asymmetric packing the schemas fix).
const SWAP_EXECUTION: AttestedExecutionSpec = {
  label: "swap",
  requestsPath: VAULT_SWAP_REQUESTS_PATH,
  outputSchema: SWAP_OUTPUT_SCHEMA,
  respondSchema: SWAP_RESPOND_SCHEMA,
  amountOf: (decoded) => (decoded as { amountIn: bigint }).amountIn,
};

/**
 * Poll until the MPC posts a signature-verified attestation for the swap
 * ({@link pollAttestedExecution} over the swap request map).
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested amountIn spent, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollSwapOutcome(
  context: VaultContext,
  options: PollAttestedExecutionOptions,
): Promise<SwapOutcome> {
  const { event, serializedOutput, amount } = await pollAttestedExecution(
    context,
    SWAP_EXECUTION,
    options,
  );
  return { event, serializedOutput, amountIn: amount };
}

/**
 * Settle a resolved swap outcome through the circuit its verified kind selects: `completeSwap`
 * for an executed attestation (mints the exact amountOut of tokenOut plus the unspent tokenIn
 * as change), `refundSwap` for a failed or unviable one (re-mints the surrendered
 * amountInMaximum). Both consume the request the event names.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollSwapOutcome}.
 * @returns The attested amountIn spent (0 on refund) and whether the swap was refunded.
 */
export async function settleSwap(
  context: VaultContext,
  outcome: SwapOutcome,
): Promise<{ amountIn: bigint; refunded: boolean }> {
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  if (outcome.event.outputKind !== OutputKind.executed) {
    console.log(
      `swap tx never executed (${OutputKind[outcome.event.outputKind]}): refunding tokenIn to this wallet`,
    );
    const r = await context.vault.callTx.refundSwap(
      respondBidirectionalEventToCircuitInput(outcome.event),
      outcome.serializedOutput,
      mintNonce,
    );
    console.log(`refund settled in tx ${r.public.txId}`);
    return { amountIn: 0n, refunded: true };
  }
  // completeSwap mints two coins (the swapped output and the unspent change), each under its
  // own random nonce: a derived second nonce would leave the change coin no entropy of its own.
  const changeNonce = crypto.getRandomValues(new Uint8Array(32));
  const r = await context.vault.callTx.completeSwap(
    respondBidirectionalEventToCircuitInput(outcome.event),
    outcome.serializedOutput,
    mintNonce,
    changeNonce,
  );
  console.log(
    `completeSwap settled ${requestIdHex(outcome.event.requestId)} in tx ${r.public.txId}`,
  );
  await logTokenAmount(
    context.evmRpcUrl,
    context.erc20Address,
    context.evmVaultAddress,
    outcome.amountIn,
    "swap spent input",
  );
  return { amountIn: outcome.amountIn, refunded: false };
}

/**
 * Poll until the swap outcome resolves, then settle: {@link pollSwapOutcome}
 * followed by {@link settleSwap}.
 *
 * @param context - The flow context.
 * @param requestId - The swap request id to settle.
 * @returns The attested amountIn spent (0 on refund) and whether the swap was refunded.
 */
export async function completeSwap(
  context: VaultContext,
  requestId: RequestIdHex,
): Promise<{ amountIn: bigint; refunded: boolean }> {
  const outcome = await pollSwapOutcome(context, { requestId });
  return settleSwap(context, outcome);
}
