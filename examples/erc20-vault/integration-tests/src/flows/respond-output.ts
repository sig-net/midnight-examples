// Respond-output resolution: the client half of the signature-only
// attestation protocol. The MPC's RespondBidirectionalEvent carries only the
// ECDSA signature over the attestation digest (binding requestId, the
// destination block height and serializedOutput), never the digest and never
// the output itself, so the client obtains the height and the output bytes
// independently and checks the signature against them. Every call builds the
// candidate outputs the chosen OutputSource yields and tries the posted
// events against each:
//
//   OutputSource.EVMNode  -> success candidate: the mined transaction's raw
//                            traced output (see ../observed-execution.ts),
//                            decoded per the request's output deserialisation
//                            schema and re-packed per its respond
//                            serialisation schema, at the block the receipt
//                            names. Only computable when the observation
//                            reports an executed transaction with output
//                            bytes.
//                            failure candidate: the protocol's fixed 5-byte
//                            failure output (MPC_FAILURE_OUTPUT) at that same
//                            block, schema-independent by design, always a
//                            candidate.
//   OutputSource.MPCCache -> the one object the MPC cached for the request
//                            before it posted (the SDK's MpcOutputCacheReader):
//                            the block height and the attested bytes
//                            verbatim, success and failure output alike.
//
// Candidate selection is by SIGNATURE VERIFICATION alone, against the
// response key the vault pinned at initialise: neither the observation's own
// success flag nor the cache's contents is authenticated, they only decide
// which candidates exist. With no digest on the event there is nothing else
// to match on. Which candidate verified is also what routes settlement: a
// success candidate goes to `completeDeposit` for a sweep and to
// `completeWithdraw` for a transfer, the failure candidate is unclaimable on
// a sweep and goes to `refundWithdraw` on a transfer. The fetched output is
// UNTRUSTED until that check: the verified bytes go into the settle circuit
// as an argument, where `verifyRespondBidirectionalEvent<N>` re-hashes them
// and verifies the same signature in-circuit. That in-circuit check is the
// authentication gate, so a forged post merely wastes a proof here, it
// cannot mint.
import {
  type AttestedOutput,
  boolAbiWord,
  deserializeEvmOutput,
  isMpcFailureOutput,
  MPC_FAILURE_OUTPUT,
  type MpcOutputCacheReader,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  serializeRespondOutput,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { type ObservedExecution, observeExecution } from "../observed-execution.ts";
import { OutputSource } from "../output-source.ts";
import type { PollProgress } from "../poll-progress.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { warnOnce } from "../warn-once.ts";

/** What the MPC attested for a request, resolved by signature verification. */
export interface RespondOutcome {
  /** The attested event whose signature verified over a candidate output. */
  readonly event: RespondBidirectionalEvent;
  /** The output bytes the signature covers (a circuit argument). */
  readonly serializedOutput: Uint8Array;
  /** The destination block height the signature covers (a circuit argument). */
  readonly blockHeight: bigint;
  /**
   * True only when a SUCCESS candidate matched AND it is the packing of a
   * true transfer result under the request's schemas. The vault's ERC20
   * transfer schema packs a single bool, so `succeeded: false` alongside
   * `matchedFailureOutput: false` means the transfer executed and returned
   * false.
   */
  readonly succeeded: boolean;
  /**
   * True when the matched candidate is the protocol's fixed failure output
   * (MPC_FAILURE_OUTPUT): the transaction reverted or was replaced, so the
   * transfer never executed.
   */
  readonly matchedFailureOutput: boolean;
}

/**
 * The request's two schemas as JSON text, read off its on-ledger record
 * (`SignBidirectionalEvent`): they are what the MPC ran.
 */
export interface RespondOutputSchemas {
  /** The record's `outputDeserializationSchema`: decodes the raw EVM return data into named values. */
  readonly outputDeserializationSchema: string;
  /** The record's `respondSerializationSchema`: packs those values into the bytes the MPC attests. */
  readonly respondSerializationSchema: string;
}

/** One output a posted attestation may commit to. */
interface OutputCandidate extends AttestedOutput {
  /** Whether the candidate is the protocol's fixed failure output. */
  readonly isFailureOutput: boolean;
}

/**
 * Record a per-tick failure where the caller reads diagnostics: the
 * enclosing poll's progress when there is one, else the console, once per
 * condition and request.
 *
 * @param progress - The enclosing poll's diagnostics, if any.
 * @param key - Stable condition identifier.
 * @param requestId - The request the condition concerns.
 * @param message - What went wrong this tick.
 */
function reportTickFailure(
  progress: PollProgress | undefined,
  key: string,
  requestId: RequestIdHex,
  message: string,
): void {
  if (progress === undefined) {
    warnOnce(
      `${key}:${requestId}`,
      `${message} (request ${requestId}, retried on the next poll tick)`,
    );
    return;
  }
  progress.failure(key, message);
}

// How long one poll tick waits on the trace. Deliberately short: the OUTER
// poll loop (pollRespondBidirectional's timeoutMs and intervalMs) owns the
// deadline, so a tick that cannot observe gives up fast and lets the next
// tick retry.
const OBSERVATION_TICK_TIMEOUT_MS = 3_000;

/**
 * The {@link OutputSource.EVMNode} candidates: the observed execution's raw
 * output decoded per the request's output deserialisation schema and
 * re-packed per its respond serialisation schema (the exact two conversions
 * the MPC ran), then the failure output. The success candidate needs an
 * executed transaction with output bytes, and a decode failure (for example
 * empty `0x` return data from a non-bool ERC20) drops it with a warning,
 * leaving only the failure candidate able to verify.
 *
 * @param context - The flow context, whose EVM endpoint serves the trace.
 * @param reader - The reader over the request map, which rebuilds the mined transaction.
 * @param requestId - The request whose execution result to recompute.
 * @param schemas - The request's schemas.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The candidates, failure last, or `undefined` when the execution
 *   could not be observed this tick.
 */
async function evmNodeCandidates(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  schemas: RespondOutputSchemas,
  progress: PollProgress | undefined,
): Promise<OutputCandidate[] | undefined> {
  let observed: ObservedExecution;
  try {
    observed = await observeExecution(
      reader,
      context.evmRpcUrl,
      requestId,
      OBSERVATION_TICK_TIMEOUT_MS,
    );
  } catch (error) {
    reportTickFailure(
      progress,
      "observation",
      requestId,
      `execution observation failed: ${String(error)}`,
    );
    return undefined;
  }

  // The success candidate is tried first (a genuine MPC signs exactly one
  // output, so order only matters against forged posts).
  const candidates: OutputCandidate[] = [];
  if (observed.success && observed.output !== null) {
    try {
      const decoded = deserializeEvmOutput(schemas.outputDeserializationSchema, observed.output);
      candidates.push({
        serializedOutput: serializeRespondOutput(schemas.respondSerializationSchema, decoded),
        blockHeight: observed.blockNumber,
        isFailureOutput: false,
      });
    } catch (error) {
      reportTickFailure(
        progress,
        "decode",
        requestId,
        `execution output decode failed, matching against the failure candidate only: ${String(error)}`,
      );
    }
  }
  candidates.push({
    serializedOutput: MPC_FAILURE_OUTPUT,
    blockHeight: observed.blockNumber,
    isFailureOutput: true,
  });
  return candidates;
}

/**
 * The {@link OutputSource.MPCCache} candidate: the object the MPC cached for
 * the request, verbatim. The vault's transfer schemas pack to one byte, so
 * equality with the 5-byte failure output is unambiguous here (a schema
 * packing to exactly 5 bytes could not tell the two apart this way).
 *
 * @param cache - The reader over the MPC's output cache.
 * @param requestId - The request whose attested output to fetch.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The single candidate, or `undefined` when the cache holds no
 *   object yet or could not be read this tick.
 */
async function mpcCacheCandidates(
  cache: MpcOutputCacheReader,
  requestId: RequestIdHex,
  progress: PollProgress | undefined,
): Promise<OutputCandidate[] | undefined> {
  let cached: AttestedOutput | undefined;
  try {
    cached = await cache.fetchAttestedOutput(requestId);
  } catch (error) {
    reportTickFailure(
      progress,
      "cache",
      requestId,
      `MPC output cache read failed: ${String(error)}`,
    );
    return undefined;
  }
  if (cached === undefined) {
    reportTickFailure(
      progress,
      "cache-miss",
      requestId,
      `MPC output cache holds no object yet at ${cache.objectUrl(requestId)}`,
    );
    return undefined;
  }
  return [{ ...cached, isFailureOutput: isMpcFailureOutput(cached.serializedOutput) }];
}

/**
 * The candidate outputs `outputSource` yields for the request this tick.
 *
 * @param context - The flow context.
 * @param reader - The reader over the request map.
 * @param requestId - The request to resolve.
 * @param outputSource - Where to obtain the attested output from.
 * @param schemas - The request's schemas.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The candidates in preference order, or `undefined` when the
 *   source could not yield them this tick.
 * @throws {Error} When {@link OutputSource.MPCCache} is asked of a context
 *   configured without a cache (`MPC_OUTPUT_CACHE_URL` unset).
 */
function candidatesFromSource(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  outputSource: OutputSource,
  schemas: RespondOutputSchemas,
  progress: PollProgress | undefined,
): Promise<OutputCandidate[] | undefined> {
  switch (outputSource) {
    case OutputSource.EVMNode:
      return evmNodeCandidates(context, reader, requestId, schemas, progress);
    case OutputSource.MPCCache: {
      if (context.mpcOutputCache === undefined) {
        throw new Error(
          `${OutputSource.MPCCache} needs MPC_OUTPUT_CACHE_URL set: the MPC's output cache URL down to its object prefix`,
        );
      }
      return mpcCacheCandidates(context.mpcOutputCache, requestId, progress);
    }
  }
}

/**
 * The bytes a transfer that returned true attests: the EVM's `true` return
 * word run through the request's two schema conversions, so a comparison
 * against it needs no knowledge of the schema's field name.
 *
 * @param schemas - The request's schemas.
 * @returns The packed respond output of a true transfer result.
 */
function packedTransferSuccess(schemas: RespondOutputSchemas): Uint8Array {
  return serializeRespondOutput(
    schemas.respondSerializationSchema,
    deserializeEvmOutput(schemas.outputDeserializationSchema, boolAbiWord(true)),
  );
}

/**
 * Whether two byte strings are identical.
 *
 * @param left - One byte string.
 * @param right - The other.
 * @returns True when both have the same length and bytes.
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Resolve the attested outcome for `requestId`: fetch the posted
 * RespondBidirectionalEvents, obtain the candidate serialised outputs from
 * `outputSource`, and return the first event whose signature verifies over
 * one of the candidates against the response key the vault pinned at
 * initialise.
 *
 * Under {@link OutputSource.EVMNode} the candidates are recomputed from the
 * mined transaction's trace with the request's own schemas
 * ({@link RespondOutputSchemas}); under {@link OutputSource.MPCCache} the one
 * candidate is the object the MPC cached before it posted. The respond
 * events are unauthenticated (anyone may post), so the signature check is
 * what selects a trustworthy record here, and the settle circuits run the
 * same check in-circuit, which remains the actual authentication gate.
 *
 * A source failure inside one call (a trace that times out, a cache object
 * not written yet) logs once and yields `undefined`, so the caller's poll
 * loop (its own timeoutMs/intervalMs) owns the deadline: this function never
 * blocks a tick beyond a short trace timeout.
 *
 * @param context - The flow context.
 * @param requestId - The request id to resolve.
 * @param outputSource - Where to obtain the attested serialised output from.
 * @param schemas - The request's schemas, as JSON text read off its on-ledger
 *   record.
 * @param requestsPath - The resolved ledger-tree path of the map holding the
 *   request: `VAULT_DEPOSIT_REQUESTS_PATH` for a deposit sweep, the default
 *   `VAULT_REQUESTS_PATH` for a withdraw transfer.
 * @param progress - Optional diagnostics for the enclosing poll.
 * @returns The verified outcome, or `undefined` when no attestation has been
 *   posted yet, none verifies over a candidate, or the source could not
 *   yield the candidates this tick.
 * @throws {Error} When {@link OutputSource.MPCCache} is asked of a context
 *   configured without a cache (`MPC_OUTPUT_CACHE_URL` unset).
 */
export async function fetchAttestedRespondOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
  outputSource: OutputSource,
  schemas: RespondOutputSchemas,
  requestsPath?: readonly number[],
  progress?: PollProgress,
): Promise<RespondOutcome | undefined> {
  const reader = createResponseReader(context, requestsPath);
  const events = await reader.getRespondBidirectionalEvents(requestId);
  progress?.update(`${String(events.length)} attestation posts observed`);
  if (events.length === 0) {
    return undefined;
  }

  // The key the settle circuit will verify against, read from the vault's own
  // ledger: checking off-chain against anything else risks accepting a post
  // that cannot prove.
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );

  // An attestation is posted, so the attested output exists at the source:
  // the transaction has executed and the MPC cached its bytes before posting.
  // UNTRUSTED until the signature check below.
  const candidates = await candidatesFromSource(
    context,
    reader,
    requestId,
    outputSource,
    schemas,
    progress,
  );
  if (candidates === undefined) {
    return undefined;
  }

  for (const candidate of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        candidate.blockHeight,
        candidate.serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    if (event !== undefined) {
      return {
        event,
        serializedOutput: candidate.serializedOutput,
        blockHeight: candidate.blockHeight,
        succeeded:
          !candidate.isFailureOutput &&
          bytesEqual(candidate.serializedOutput, packedTransferSuccess(schemas)),
        matchedFailureOutput: candidate.isFailureOutput,
      };
    }
  }
  progress?.update(
    `${String(events.length)} attestation posts rejected against ${String(candidates.length)} output candidates`,
  );
  progress?.failure(
    "verification",
    `no signature verifies against the vault response key and the ${outputSource} output`,
  );
  return undefined;
}
