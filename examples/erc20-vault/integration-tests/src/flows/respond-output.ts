// Candidate output bytes remain untrusted until the response signature verifies
// against the key sealed into the vault. Only the verified candidate selects
// the settlement path and supplies its circuit arguments.
import {
  deserializeEvmOutput,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  serializeRespondOutput,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { ObservedExecution } from "@sig-net/midnight-examples-lib";
import { observeExecution } from "@sig-net/midnight-examples-lib";

import { ERC20_TRANSFER_RESULT_SCHEMA } from "../mpc-routing.ts";
import type { PollProgress } from "../poll-progress.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { warnOnce } from "../warn-once.ts";

/** What the MPC attested for a request, resolved by signature verification. */
export interface RespondOutcome {
  /** The attested event whose signature verified over a recomputed candidate. */
  readonly event: RespondBidirectionalEvent;
  /** The recomputed output bytes the signature covers (a circuit argument). */
  readonly serializedOutput: Uint8Array;
  /**
   * True only when the SUCCESS candidate matched AND its decoded transfer
   * result bool is true. The vault's ERC20 transfer schema decodes a single
   * bool, so `succeeded: false` alongside `matchedFailureOutput: false`
   * means the transfer executed and returned false.
   */
  readonly succeeded: boolean;
  /**
   * True when the matched candidate is the protocol's fixed failure output
   * (MPC_FAILURE_OUTPUT), by candidate identity: the transaction reverted or
   * was replaced, so the transfer never executed.
   */
  readonly matchedFailureOutput: boolean;
}

// How long one poll tick waits on the trace. Deliberately
// short: the OUTER poll loop (pollRespondBidirectional's timeoutMs and
// intervalMs) owns the deadline, so a tick that cannot observe gives up fast
// and lets the next tick retry.
const OBSERVATION_TICK_TIMEOUT_MS = 3_000;

/**
 * Resolve the attested outcome for `requestId`: fetch the posted
 * RespondBidirectionalEvents, recompute both candidate serialized outputs,
 * and return the first event whose signature verifies over one of the
 * candidates against the response key the vault pinned at initialise.
 *
 * The failure candidate (the protocol's fixed 5-byte failure output) is
 * always computed. The success candidate (the observed execution's raw
 * output, decoded per the schema and re-packed per the schema, the exact two
 * conversions the MPC ran on its side) is attempted only when the
 * observation reports an executed transaction with output bytes, and a decode
 * failure (for example empty `0x` return data from a non-bool ERC20) drops
 * it with a warning rather than crashing the poll. The respond events are
 * unauthenticated (anyone may post), so that signature check is what selects
 * a trustworthy record here, and the settle circuits run the same check
 * in-circuit, which remains the actual authentication gate.
 *
 * An observation failure inside one call logs once and yields `undefined`,
 * so the caller's poll loop (its own timeoutMs/intervalMs) owns the
 * deadline: this function never blocks a tick beyond a short trace timeout.
 *
 * @param context - The flow context.
 * @param requestId - The request id to resolve.
 * @param requestsPath - The resolved ledger-tree path of the map holding the
 *   request: `VAULT_DEPOSIT_REQUESTS_PATH` for a deposit sweep, the default
 *   `VAULT_REQUESTS_PATH` for a withdraw transfer.
 * @param progress - Optional diagnostics for the enclosing poll.
 * @returns The verified outcome, or `undefined` when no attestation has been
 *   posted yet, none verifies over a recomputed candidate, or the mined
 *   transaction could not be traced this tick.
 */
export async function fetchAttestedRespondOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
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

  // An attestation is posted, so the transaction has executed and its result
  // is observable: observe it now, with a short per-tick timeout. UNTRUSTED
  // until the signature check below.
  let observed: ObservedExecution;
  try {
    observed = await observeExecution(
      reader,
      context.evmRpcUrl,
      requestId,
      OBSERVATION_TICK_TIMEOUT_MS,
    );
  } catch (error) {
    progress?.failure("observation", `execution observation failed: ${String(error)}`);
    if (progress === undefined)
      warnOnce(
        `observe:${requestId}`,
        `could not observe the execution of ${requestId}, will retry on the next poll tick: ${String(error)}`,
      );
    return undefined;
  }

  // The failure candidate always exists. The success candidate needs observed
  // output bytes, and its decode/re-pack may fail (for example empty `0x`
  // return data from an ERC20 that returns nothing): then only the failure
  // candidate can verify. The success candidate is tried first (a genuine MPC
  // signs exactly one output, so order only matters against forged posts).
  const candidates: { serializedOutput: Uint8Array; isFailureOutput: boolean }[] = [];
  let decodedSuccessValue: boolean | undefined;
  if (observed.success && observed.output !== null) {
    try {
      const decoded = deserializeEvmOutput(ERC20_TRANSFER_RESULT_SCHEMA, observed.output);
      decodedSuccessValue = decoded.success === true;
      candidates.push({
        serializedOutput: serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, decoded),
        isFailureOutput: false,
      });
    } catch (error) {
      progress?.failure("decode", `execution output decode failed: ${String(error)}`);
      if (progress === undefined)
        warnOnce(
          `decode:${requestId}`,
          `could not decode/re-pack the observed output for ${requestId} ` +
            `(matching against the failure candidate only): ${String(error)}`,
        );
    }
  }
  candidates.push({ serializedOutput: MPC_FAILURE_OUTPUT, isFailureOutput: true });

  for (const candidate of candidates) {
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        candidate.serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    if (event !== undefined) {
      return {
        event,
        serializedOutput: candidate.serializedOutput,
        succeeded: !candidate.isFailureOutput && decodedSuccessValue === true,
        matchedFailureOutput: candidate.isFailureOutput,
      };
    }
  }
  progress?.update(
    `${String(events.length)} attestation posts rejected against ${String(candidates.length)} output candidates`,
  );
  progress?.failure(
    "verification",
    "no signature verifies against the vault response key and observed output",
  );
  return undefined;
}
