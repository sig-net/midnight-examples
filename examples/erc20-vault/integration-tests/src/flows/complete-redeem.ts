// Settle side of the redeem flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit its verified output kind selects
// (completeRedeem mints the attested USDC assets, refundRedeem re-mints the surrendered shares).
import {
  deserializeEvmOutput,
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  type Secp256k1Point,
  serializeRespondOutput,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { AAVE_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { VAULT_REDEEM_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { logTokenAmount } from "../evm-logging.ts";
import { REDEEM_OUTPUT_SCHEMA, REDEEM_RESPOND_SCHEMA } from "../evm-stata.ts";
import { type ObservedExecution, observeExecution } from "../observed-execution.ts";
import { PollProgress } from "../poll-progress.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/**
 * The resolved attested outcome of a redeem: the verified event (its `outputKind` the MPC's
 * verdict), the bytes it signs, and the assets they carry (0 under a failure kind).
 */
export interface RedeemOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
}

/** An executed redeem's recomputed output and the assets settling on it yields. */
interface ExecutedRedeemOutput {
  readonly serializedOutput: Uint8Array;
  readonly assets: bigint;
}

// How long one candidate build waits on the trace. Short on purpose: the poll
// loop owns the deadline, so a tick that cannot observe gives up fast and the next retries.
const OBSERVATION_TICK_TIMEOUT_MS = 3_000;

/**
 * Recompute the output an executed redeem attests (the redeem-schema twin of
 * complete-supply.ts's candidate build): the observed traced output decoded per the uint256
 * output schema and re-packed per the uint64 respond schema. A reverted transaction has no
 * output, and a decode failure drops the candidate with a warning: either way only failure
 * posts can then verify, over the empty output that needs no observation. An execution has
 * one fixed observation per request, so a caller resolving this once holds the candidate for
 * its whole poll.
 *
 * @param context - The flow context, whose EVM endpoint serves the trace.
 * @param reader - The reader over the redeem request map, which rebuilds the mined transaction.
 * @param requestId - The redeem request id whose execution result to recompute.
 * @param progress - Diagnostics for the enclosing poll.
 * @returns The executed output, or undefined when the execution cannot be observed this tick
 *   or did not produce one.
 */
async function fetchExecutedRedeemOutput(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  progress: PollProgress,
): Promise<ExecutedRedeemOutput | undefined> {
  let observed: ObservedExecution;
  try {
    observed = await observeExecution(
      reader,
      context.evmRpcUrl,
      requestId,
      OBSERVATION_TICK_TIMEOUT_MS,
    );
  } catch (error) {
    progress.failure("observation", `execution observation failed: ${String(error)}`);
    return undefined;
  }
  if (!observed.success || observed.output === null) {
    return undefined;
  }
  try {
    const decoded = deserializeEvmOutput(REDEEM_OUTPUT_SCHEMA, observed.output);
    return {
      serializedOutput: serializeRespondOutput(REDEEM_RESPOND_SCHEMA, decoded),
      assets: (decoded as { assets: bigint }).assets,
    };
  } catch (error) {
    progress.failure("decode", `execution output decode failed: ${String(error)}`);
    return undefined;
  }
}

/**
 * Select the outcome of the first posted event whose ECDSA signature verifies over the bytes
 * its declared kind selects: the recomputed executed output for an executed post, the empty
 * output for a failed or unviable one. The declared kind is unauthenticated routing data, so
 * this signature check against the vault-pinned response key is the whole of selection.
 *
 * @param events - The posts declared under the request id, unverified as the event log allows.
 * @param executed - The recomputed executed output, or undefined when none is available yet.
 * @param mpcResponseKey - The response key the vault pinned at initialise.
 * @returns The matching outcome, or undefined when no post verifies.
 */
function matchRedeemOutcome(
  events: readonly RespondBidirectionalEvent[],
  executed: ExecutedRedeemOutput | undefined,
  mpcResponseKey: Secp256k1Point,
): RedeemOutcome | undefined {
  for (const event of events) {
    if (event.outputKind === OutputKind.executed) {
      if (
        executed !== undefined &&
        verifyRespondBidirectionalSignature(executed.serializedOutput, event, mpcResponseKey)
      ) {
        return { event, serializedOutput: executed.serializedOutput, assets: executed.assets };
      }
    } else if (verifyRespondBidirectionalSignature(EMPTY_OUTPUT, event, mpcResponseKey)) {
      return { event, serializedOutput: EMPTY_OUTPUT, assets: 0n };
    }
  }
  return undefined;
}

/** Options for {@link pollRedeemOutcome}. */
export interface PollRedeemOutcomeOptions {
  /** The redeem request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; {@link POLL_TIMEOUT_MS} when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the redeem
 * (see {@link matchRedeemOutcome} for candidate selection).
 *
 * Everything a tick would otherwise redo is resolved once: the reader, whose request-record
 * cache a rebuild would throw away, the response key the vault pinned at initialise, and the
 * executed output {@link fetchExecutedRedeemOutput} recomputes from the execution's fixed
 * observation, built only once a post declares an executed transaction. A tick costs one
 * event read plus a signature check per post.
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested assets minted, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollRedeemOutcome(
  context: VaultContext,
  options: PollRedeemOutcomeOptions,
): Promise<RedeemOutcome> {
  const reader = createResponseReader(context, VAULT_REDEEM_REQUESTS_PATH);
  // The key the settle circuit verifies against, read from the vault's own ledger: checking
  // off-chain against anything else risks accepting a post that cannot prove. initialise
  // writes it once and nothing rewrites it, so one read serves every tick.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const progress = new PollProgress(
    `redeem attestation ${options.requestId}`,
    options.timeoutMs ?? POLL_TIMEOUT_MS,
  );
  const end = Date.now() + (options.timeoutMs ?? POLL_TIMEOUT_MS);
  let executed: ExecutedRedeemOutput | undefined;
  while (Date.now() < end) {
    const events = await reader.getRespondBidirectionalEvents(options.requestId);
    progress.update(`${String(events.length)} attestation posts observed`);
    if (events.length > 0) {
      // A post declaring an executed transaction means its result is observable, so the
      // executed output is worth recomputing only once such a post appears.
      if (events.some((posted) => posted.outputKind === OutputKind.executed)) {
        executed ??= await fetchExecutedRedeemOutput(context, reader, options.requestId, progress);
      }
      const outcome = matchRedeemOutcome(events, executed, mpcResponseKey);
      if (outcome !== undefined) return outcome;
      progress.update(`${String(events.length)} attestation posts rejected`);
      progress.failure(
        "verification",
        "no signature verifies against the vault response key and the output its kind selects",
      );
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
  throw new Error(`timed out: ${progress.summary()}`);
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
