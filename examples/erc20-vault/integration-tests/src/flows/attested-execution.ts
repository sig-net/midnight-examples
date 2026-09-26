// The attestation poll every vault-signed request with a re-packed EVM return
// value shares (swap, supply, redeem): resolve the MPC's post by signature
// verification over the bytes its declared kind selects, the recomputed
// executed output for an executed post and the empty output for a failed or
// unviable one. Each flow supplies its request map, its two schemas and how
// to read the settlement amount out of the decoded output, and keeps its own
// outcome record and settle circuit.
import {
  type AbiDecodedOutput,
  deserializeEvmOutput,
  OutputKind,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  type Secp256k1Point,
  serializeRespondOutput,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { type ObservedExecution, observeExecution } from "../observed-execution.ts";
import { PollProgress } from "../poll-progress.ts";
import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/**
 * The resolved attested outcome of a request whose executed output packs one
 * settlement amount: the verified event (its `outputKind` the MPC's verdict),
 * the bytes it signs, and the amount they carry (0 under a failure kind).
 */
export interface AttestedExecution {
  readonly event: RespondBidirectionalEvent;
  readonly serializedOutput: Uint8Array;
  readonly amount: bigint;
}

/** What a flow contributes to {@link pollAttestedExecution}: its map, its schemas, its amount. */
export interface AttestedExecutionSpec {
  /** The flow's name in poll diagnostics. */
  readonly label: string;
  /** The resolved ledger-tree path of the request map the flow records into. */
  readonly requestsPath: readonly number[];
  /** The request's output deserialisation schema, as the contract declares it. */
  readonly outputSchema: Uint8Array;
  /** The request's respond serialisation schema, as the contract declares it. */
  readonly respondSchema: Uint8Array;
  /**
   * The settlement amount in the decoded executed output.
   *
   * @param decoded - The traced output decoded per `outputSchema`.
   * @returns The amount the settle circuit mints on.
   */
  readonly amountOf: (decoded: AbiDecodedOutput) => bigint;
}

/** An executed request's recomputed output and the amount settling on it yields. */
interface ExecutedOutput {
  readonly serializedOutput: Uint8Array;
  readonly amount: bigint;
}

// How long one candidate build waits on the trace. Short on purpose: the poll
// loop owns the deadline, so a tick that cannot observe gives up fast and the next retries.
const OBSERVATION_TICK_TIMEOUT_MS = 3_000;

/**
 * Recompute the output an executed request attests: the observed traced output decoded per
 * the flow's output schema and re-packed per its respond schema (the exact two conversions
 * the MPC ran). A reverted transaction has no output, and a decode failure drops the candidate
 * with a warning: either way only failure posts can then verify, over the empty output that
 * needs no observation. An execution has one fixed observation per request, so a caller
 * resolving this once holds the candidate for its whole poll.
 *
 * @param context - The flow context, whose EVM endpoint serves the trace.
 * @param reader - The reader over the request map, which rebuilds the mined transaction.
 * @param spec - The flow's schemas and amount reader.
 * @param requestId - The request id whose execution result to recompute.
 * @param progress - Diagnostics for the enclosing poll.
 * @returns The executed output, or undefined when the execution cannot be observed this tick
 *   or did not produce one.
 */
async function fetchExecutedOutput(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  spec: AttestedExecutionSpec,
  requestId: RequestIdHex,
  progress: PollProgress,
): Promise<ExecutedOutput | undefined> {
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
    const decoded = deserializeEvmOutput(spec.outputSchema, observed.output);
    return {
      serializedOutput: serializeRespondOutput(spec.respondSchema, decoded),
      amount: spec.amountOf(decoded),
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
function matchAttestedExecution(
  events: readonly RespondBidirectionalEvent[],
  executed: ExecutedOutput | undefined,
  mpcResponseKey: Secp256k1Point,
): AttestedExecution | undefined {
  for (const event of events) {
    if (event.outputKind === OutputKind.executed) {
      if (
        executed !== undefined &&
        verifyRespondBidirectionalSignature(executed.serializedOutput, event, mpcResponseKey)
      ) {
        return { event, serializedOutput: executed.serializedOutput, amount: executed.amount };
      }
    } else if (verifyRespondBidirectionalSignature(EMPTY_OUTPUT, event, mpcResponseKey)) {
      return { event, serializedOutput: EMPTY_OUTPUT, amount: 0n };
    }
  }
  return undefined;
}

/** Options for {@link pollAttestedExecution} and the flow polls built on it. */
export interface PollAttestedExecutionOptions {
  /** The request id to resolve. */
  readonly requestId: RequestIdHex;
  /** Poll interval; 1s when omitted. */
  readonly intervalMs?: number;
  /** Give-up horizon; {@link POLL_TIMEOUT_MS} when omitted. */
  readonly timeoutMs?: number;
}

/**
 * Poll until the MPC posts a signature-verified attestation for the request
 * (see {@link matchAttestedExecution} for candidate selection).
 *
 * Everything a tick would otherwise redo is resolved once: the reader, whose request-record
 * cache a rebuild would throw away, the response key the vault pinned at initialise, and the
 * executed output {@link fetchExecutedOutput} recomputes from the execution's fixed
 * observation, built only once a post declares an executed transaction. A tick costs one
 * event read plus a signature check per post.
 *
 * @param context - The flow context.
 * @param spec - The flow's map, schemas and amount reader.
 * @param options - The request id and poll cadence.
 * @returns The resolved outcome (an attested amount, or a failure kind).
 * @throws {Error} If no matching attestation posts within the timeout.
 */
export async function pollAttestedExecution(
  context: VaultContext,
  spec: AttestedExecutionSpec,
  options: PollAttestedExecutionOptions,
): Promise<AttestedExecution> {
  const reader = createResponseReader(context, spec.requestsPath);
  // The key the settle circuit verifies against, read from the vault's own ledger: checking
  // off-chain against anything else risks accepting a post that cannot prove. initialise
  // writes it once and nothing rewrites it, so one read serves every tick.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  const progress = new PollProgress(
    `${spec.label} attestation ${options.requestId}`,
    options.timeoutMs ?? POLL_TIMEOUT_MS,
  );
  const end = Date.now() + (options.timeoutMs ?? POLL_TIMEOUT_MS);
  let executed: ExecutedOutput | undefined;
  while (Date.now() < end) {
    const events = await reader.getRespondBidirectionalEvents(options.requestId);
    progress.update(`${String(events.length)} attestation posts observed`);
    if (events.length > 0) {
      // A post declaring an executed transaction means its result is observable, so the
      // executed output is worth recomputing only once such a post appears.
      if (events.some((posted) => posted.outputKind === OutputKind.executed)) {
        executed ??= await fetchExecutedOutput(context, reader, spec, options.requestId, progress);
      }
      const outcome = matchAttestedExecution(events, executed, mpcResponseKey);
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
