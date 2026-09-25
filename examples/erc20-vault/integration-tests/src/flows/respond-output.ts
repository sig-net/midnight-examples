// Respond-output resolution: the client half of the attestation protocol.
// The MPC's RespondBidirectionalEvent carries the request id, the
// destination block height, its verdict (the output kind), the output's
// width, the attestation digest and the ECDSA signature over that digest,
// never the serialised output itself, so the client obtains the output bytes
// independently and checks the signature against them. A post's declared
// kind picks the bytes it is checked over, and the chosen OutputSource yields
// them:
//
//   OutputSource.EVMNode  -> a post declaring an executed transaction is
//                            checked over the mined transaction's raw traced
//                            output (see ../observed-execution.ts), decoded
//                            per the request's output deserialisation schema
//                            and re-packed per its respond serialisation
//                            schema. Only computable when the observation
//                            reports an executed transaction with output
//                            bytes. A post declaring a failed or unviable
//                            transaction is checked over the empty output the
//                            protocol attests, which needs no observation.
//   OutputSource.MPCCache -> every post is checked over the one object the
//                            MPC cached for the request before it posted (the
//                            SDK's MpcOutputCacheReader): the attested bytes
//                            verbatim, empty for a failure.
//
// Candidate selection is by SIGNATURE VERIFICATION alone, against the
// response key the vault pinned at initialise: a post's declared kind, the
// observation's own success flag and the cache's contents are all
// unauthenticated, they only decide which bytes get checked. The verified
// kind and bytes route settlement: an executed transfer goes to
// `completeDeposit` for a sweep and to `completeWithdraw` for a transfer, a
// failed or unviable one is unclaimable on a sweep and goes to
// `refundWithdraw` on a transfer. The fetched output is UNTRUSTED until that
// check: the verified bytes go into the settle circuit as an argument, where
// `verifyRespondBidirectionalEventV1<N>` re-hashes them and verifies the same
// signature in-circuit. That in-circuit check is the authentication gate, so
// a forged post merely wastes a proof here, it cannot mint.
import {
  boolAbiWord,
  deserializeEvmOutput,
  type MpcOutputCacheReader,
  OutputKind,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  serializeRespondOutput,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { type ObservedExecution, observeExecution } from "../observed-execution.ts";
import { OutputSource } from "../output-source.ts";
import type { PollProgress } from "../poll-progress.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { warnOnce } from "../warn-once.ts";

/** What the MPC attested for a request, resolved by signature verification. */
export interface RespondOutcome {
  /**
   * The attested event whose signature verified over `serializedOutput`. Its
   * `outputKind` is the MPC's verified verdict and its `requestId` the
   * request a settle circuit consumes.
   */
  readonly event: RespondBidirectionalEvent;
  /**
   * The output bytes the signature covers (a circuit argument): the packed
   * respond output of an executed transaction, empty under a failure kind.
   */
  readonly serializedOutput: Uint8Array;
  /**
   * True only when the verified kind is executed AND the bytes are the
   * packing of a true transfer result under the request's schemas. The
   * vault's ERC20 transfer schema packs a single bool, so `succeeded: false`
   * beside an executed kind means the transfer executed and returned false.
   */
  readonly succeeded: boolean;
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

/** The bytes a source yields this tick, by the kind a post declares. */
interface OutputCandidates {
  /**
   * What a post declaring an executed transaction is checked over, or
   * `undefined` when the source cannot yield it this tick.
   */
  readonly executed: Uint8Array | undefined;
  /** What a post declaring a failed or unviable transaction is checked over. */
  readonly failure: Uint8Array;
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
 * The {@link OutputSource.EVMNode} candidates. The executed candidate is the
 * observed execution's raw output decoded per the request's output
 * deserialisation schema and re-packed per its respond serialisation schema
 * (the exact two conversions the MPC ran), built only when a post declares
 * an executed transaction: it needs an executed transaction with output
 * bytes, and a decode failure (for example empty `0x` return data from a
 * non-bool ERC20) drops it with a warning. The failure candidate is the
 * empty output and needs no observation at all.
 *
 * @param context - The flow context, whose EVM endpoint serves the trace.
 * @param reader - The reader over the request map, which rebuilds the mined transaction.
 * @param requestId - The request whose execution result to recompute.
 * @param schemas - The request's schemas.
 * @param executedDeclared - Whether any post declares an executed transaction.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The candidates, the executed one `undefined` when no post asks
 *   for it or the execution could not be observed this tick.
 */
async function evmNodeCandidates(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  schemas: RespondOutputSchemas,
  executedDeclared: boolean,
  progress: PollProgress | undefined,
): Promise<OutputCandidates> {
  if (!executedDeclared) {
    return { executed: undefined, failure: EMPTY_OUTPUT };
  }
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
    return { executed: undefined, failure: EMPTY_OUTPUT };
  }
  if (!observed.success || observed.output === null) {
    return { executed: undefined, failure: EMPTY_OUTPUT };
  }
  try {
    const decoded = deserializeEvmOutput(schemas.outputDeserializationSchema, observed.output);
    return {
      executed: serializeRespondOutput(schemas.respondSerializationSchema, decoded),
      failure: EMPTY_OUTPUT,
    };
  } catch (error) {
    reportTickFailure(
      progress,
      "decode",
      requestId,
      `execution output decode failed, checking failure posts only: ${String(error)}`,
    );
    return { executed: undefined, failure: EMPTY_OUTPUT };
  }
}

/**
 * The {@link OutputSource.MPCCache} candidates: the object the MPC cached for
 * the request, verbatim, whatever kind a post declares. The cache holds
 * exactly the bytes the attestation commits to, empty for a failure.
 *
 * @param cache - The reader over the MPC's output cache.
 * @param requestId - The request whose attested output to fetch.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The candidates, or `undefined` when the cache holds no object yet
 *   or could not be read this tick.
 */
async function mpcCacheCandidates(
  cache: MpcOutputCacheReader,
  requestId: RequestIdHex,
  progress: PollProgress | undefined,
): Promise<OutputCandidates | undefined> {
  let cached: Uint8Array | undefined;
  try {
    cached = await cache.fetchSerializedOutput(requestId);
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
  return { executed: cached, failure: cached };
}

/**
 * The candidate outputs `outputSource` yields for the request this tick.
 *
 * @param context - The flow context.
 * @param reader - The reader over the request map.
 * @param requestId - The request to resolve.
 * @param outputSource - Where to obtain the attested output from.
 * @param schemas - The request's schemas.
 * @param executedDeclared - Whether any post declares an executed transaction.
 * @param progress - The enclosing poll's diagnostics, if any.
 * @returns The candidates, or `undefined` when the source could not yield
 *   them this tick.
 * @throws {Error} When {@link OutputSource.MPCCache} is asked of a context
 *   configured without a cache (`MPC_OUTPUT_CACHE_URL` unset).
 */
function candidatesFromSource(
  context: VaultContext,
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  outputSource: OutputSource,
  schemas: RespondOutputSchemas,
  executedDeclared: boolean,
  progress: PollProgress | undefined,
): Promise<OutputCandidates | undefined> {
  switch (outputSource) {
    case OutputSource.EVMNode:
      return evmNodeCandidates(context, reader, requestId, schemas, executedDeclared, progress);
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
 * the candidate its declared kind selects, against the response key the
 * vault pinned at initialise.
 *
 * Under {@link OutputSource.EVMNode} the executed candidate is recomputed
 * from the mined transaction's trace with the request's own schemas
 * ({@link RespondOutputSchemas}) and the failure candidate is the empty
 * output; under {@link OutputSource.MPCCache} every post is checked over the
 * object the MPC cached before it posted. The respond events are
 * unauthenticated (anyone may post), so the signature check is what selects
 * a trustworthy record here, and the settle circuits run the same check
 * in-circuit, which remains the actual authentication gate.
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
 *   posted yet, none verifies over its candidate, or the source could not
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
  // the transaction is final and the MPC cached its bytes before posting.
  // UNTRUSTED until the signature check below.
  const candidates = await candidatesFromSource(
    context,
    reader,
    requestId,
    outputSource,
    schemas,
    events.some((posted) => posted.outputKind === OutputKind.executed),
    progress,
  );
  if (candidates === undefined) {
    return undefined;
  }

  for (const event of events) {
    const serializedOutput =
      event.outputKind === OutputKind.executed ? candidates.executed : candidates.failure;
    if (
      serializedOutput !== undefined &&
      verifyRespondBidirectionalSignature(serializedOutput, event, mpcResponseKey)
    ) {
      return {
        event,
        serializedOutput,
        succeeded:
          event.outputKind === OutputKind.executed &&
          bytesEqual(serializedOutput, packedTransferSuccess(schemas)),
      };
    }
  }
  progress?.update(`${String(events.length)} attestation posts rejected`);
  progress?.failure(
    "verification",
    `no signature verifies against the vault response key and the ${outputSource} output`,
  );
  return undefined;
}
