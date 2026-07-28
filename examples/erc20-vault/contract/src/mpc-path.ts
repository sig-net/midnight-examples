// How the MPC reads a request's 32 opaque path bytes as a derivation-path
// string. Protocol-relevant rather than vault-specific (it mirrors the fakenet
// responder's `getPath`), so it belongs in @sig-net/midnight; kept here until
// upstreamed, environment-agnostic like the rest of the export surface.

/**
 * Read 32 opaque path bytes the way the MPC's epsilon derivation does: decode
 * as UTF-8 (invalid sequences become U+FFFD, deterministically) and strip NUL
 * bytes. Mirror of the fakenet responder's `getPath`, which reads with Node's
 * `Buffer.prototype.toString("utf8")`: `TextDecoder` produces byte-identical
 * output (verified against the Buffer reading over random 32-byte inputs) and,
 * unlike `Buffer`, exists in both a browser and Node.
 *
 * Deriving a request's EVM account off-chain (`deriveEvmAddress` in
 * `@sig-net/midnight`) must apply this exact (lossy but deterministic) reading
 * to the raw path bytes the contract stored, e.g. a caller's `userCommitment`.
 *
 * @param path - The 32 path bytes as stored in the event record.
 * @returns The derivation path string.
 */
export function pathStringOfBytes(path: Uint8Array): string {
  return new TextDecoder("utf-8").decode(path).replace(/\0/g, "");
}
