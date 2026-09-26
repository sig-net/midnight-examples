// The serialised output the MPC attests for a transaction that never
// executed. Under OutputKind.failed (reverted) and OutputKind.unviable (its
// nonce taken by another transaction) the attestation digest commits to zero
// output bytes, so a client needs no observation to check a post declaring
// either kind, and the vault's refund circuits take the bytes as Bytes<0>.

/** The zero-byte output every failure attestation commits to. */
export const EMPTY_OUTPUT: Uint8Array = new Uint8Array(0);
