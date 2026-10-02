// The serialised output the MPC attests for a transaction that never
// executed, and for an executed one whose output schema is empty. Under
// OutputKind.failed (reverted) and OutputKind.unviable (its nonce taken by
// another transaction) the attestation digest commits to zero output bytes,
// so a client needs no observation to check a post declaring either kind. A
// nonce replacement's plain transfer returns nothing, so its executed
// attestation commits to the same zero bytes. The vault's queueAttestation0
// takes them as Bytes<0>.

/** The zero-byte output every failure attestation, and an executed nonce replacement's, commits to. */
export const EMPTY_OUTPUT: Uint8Array = new Uint8Array(0);
