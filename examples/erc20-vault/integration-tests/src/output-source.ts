// Where an attestation poll obtains the serialised output the MPC attested.
// A RespondBidirectionalEvent carries only the MPC's signature over
// (requestId, serializedOutput), so the client must hold the exact bytes
// before it can verify a post, and two places yield them.

/** The sources the vault flows obtain an attested serialised output from. */
export enum OutputSource {
  /**
   * Recompute the bytes from the EVM chain: trace the mined transaction on
   * `EVM_RPC_URL` (`debug_traceTransaction`) and run the request's two schema
   * conversions over its raw return data.
   */
  EVMNode = "evm-node",
  /**
   * Download the bytes the MPC cached before it posted its attestation: one
   * object per request id in the MPC's output cache (`MPC_OUTPUT_CACHE_URL`).
   */
  MPCCache = "mpc-cache",
}

/** Every source's string form, for validation and error messages. */
const OUTPUT_SOURCES: readonly string[] = Object.values(OutputSource);

/**
 * Whether `value` is an {@link OutputSource} member's string form.
 *
 * @param value - The candidate string.
 * @returns True when `value` names a source.
 */
function isOutputSource(value: string): value is OutputSource {
  return OUTPUT_SOURCES.includes(value);
}

/**
 * Resolve a `RESPOND_OUTPUT_SOURCE` value to an {@link OutputSource}.
 *
 * @param value - The env value, an {@link OutputSource} member's string form.
 * @returns The named source.
 * @throws {Error} If the value names no source.
 */
export function parseOutputSource(value: string): OutputSource {
  if (!isOutputSource(value)) {
    throw new Error(
      `unknown RESPOND_OUTPUT_SOURCE "${value}": expected one of ${OUTPUT_SOURCES.join(", ")}`,
    );
  }
  return value;
}
