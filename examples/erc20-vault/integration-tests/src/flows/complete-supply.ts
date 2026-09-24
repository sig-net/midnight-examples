// Settle side of the supply flow: resolve the MPC's attested outcome by signature
// verification, then settle through the circuit its verified output kind selects
// (completeSupply mints the attested stataUSDC shares, refundSupply re-mints the surrendered
// underlying).
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
import { STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { VAULT_SUPPLY_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { logTokenAmount } from "../evm-logging.ts";
import { SUPPLY_OUTPUT_SCHEMA, SUPPLY_RESPOND_SCHEMA } from "../evm-stata.ts";
import { type ObservedExecution, observeExecution } from "../observed-execution.ts";
import { PollProgress } from "../poll-progress.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/**
 * The resolved attested outcome of a supply: the verified event (its `outputKind` the MPC's
 * verdict), the bytes it signs, and the shares they carry (0 under a failure kind).
 */
export interface SupplyOutcome {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly shares: bigint;
}

/** An executed supply's recomputed output and the shares settling on it yields. */
interface ExecutedSupplyOutput {
  readonly serializedOutput: Uint8Array;
  readonly shares: bigint;
}

// How long one candidate build waits on the trace. Short on purpose: the poll
// loop owns the deadline, so a tick that cannot observe gives up fast and the next retries.
const OBSERVATION_TICK_TIMEOUT_MS = 3_000;

/**
 * Recompute the output an executed supply attests (the supply-schema twin of complete-swap.ts's
 * candidate build): the observed traced output decoded per the uint256 output schema and
 * re-packed per the uint64 respond schema. A reverted transaction has no output, and a decode
 * failure drops the candidate with a warning: either way only failure posts can then verify,
 * over the empty output that needs no observation. An execution has one fixed observation per
 * request, so a caller resolving this once holds the candidate for its whole poll.
 *
 * @param context - The flow context, whose EVM endpoint serves the trace.
 * @param reader - The reader over the supply request map, which rebuilds the mined transaction.
 * @param requestId - The supply request id whose execution result to recompute.
 * @param progress - Diagnostics for the enclosing poll.
 * @returns The executed output, or undefined when the execution cannot be observed this tick
 *   or did not produce one.
 */
async function fetchExecutedSupplyOutput(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  progress: PollProgress,
): Promise<ExecutedSupplyOutput | undefined> {
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
    const decoded = deserializeEvmOutput(SUPPLY_OUTPUT_SCHEMA, observed.output);
    return {
      serializedOutput: serializeRespondOutput(SUPPLY_RESPOND_SCHEMA, decoded),
      shares: (decoded as { shares: bigint }).shares,
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
function matchSupplyOutcome(
  events: readonly RespondBidirectionalEvent[],
  executed: ExecutedSupplyOutput | undefined,
  mpcResponseKey: Secp256k1Point,
): SupplyOutcome | undefined {
  for (const event of events) {
    if (event.outputKind === OutputKind.executed) {
      if (
        executed !== undefined &&
        verifyRespondBidirectionalSignature(executed.serializedOutput, event, mpcResponseKey)
      ) {
        return { event, serializedOutput: executed.serializedOutput, shares: executed.shares };
      }
    } else if (verifyRespondBidirectionalSignature(EMPTY_OUTPUT, event, mpcResponseKey)) {
      return { event, serializedOutput: EMPTY_OUTPUT, shares: 0n };
    }
  }
  return undefined;
}

/** Options for {@link pollSupplyOutcome}. */
export interface PollSupplyOutcomeOptions {
  /** The supply request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; {@link POLL_TIMEOUT_MS} when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the supply
 * (see {@link matchSupplyOutcome} for candidate selection).
 *
 * Everything a tick would otherwise redo is resolved once: the reader, whose request-record
 * cache a rebuild would throw away, the response key the vault pinned at initialise, and the
 * executed output {@link fetchExecutedSupplyOutput} recomputes from the execution's fixed
 * observation, built only once a post declares an executed transaction. A tick costs one
 * event read plus a signature check per post.
 *
 * @param context - The flow context.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (attested shares minted, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollSupplyOutcome(
  context: VaultContext,
  options: PollSupplyOutcomeOptions,
): Promise<SupplyOutcome> {
  const reader = createResponseReader(context, VAULT_SUPPLY_REQUESTS_PATH);
  // The key the settle circuit verifies against, read from the vault's own ledger: checking
  // off-chain against anything else risks accepting a post that cannot prove. initialise
  // writes it once and nothing rewrites it, so one read serves every tick.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const progress = new PollProgress(
    `supply attestation ${options.requestId}`,
    options.timeoutMs ?? POLL_TIMEOUT_MS,
  );
  const end = Date.now() + (options.timeoutMs ?? POLL_TIMEOUT_MS);
  let executed: ExecutedSupplyOutput | undefined;
  while (Date.now() < end) {
    const events = await reader.getRespondBidirectionalEvents(options.requestId);
    progress.update(`${String(events.length)} attestation posts observed`);
    if (events.length > 0) {
      // A post declaring an executed transaction means its result is observable, so the
      // executed output is worth recomputing only once such a post appears.
      if (events.some((posted) => posted.outputKind === OutputKind.executed)) {
        executed ??= await fetchExecutedSupplyOutput(context, reader, options.requestId, progress);
      }
      const outcome = matchSupplyOutcome(events, executed, mpcResponseKey);
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
