// The user's vault identity: secret key -> commitment -> MPC derivation path.
// Derivation calls the compiled circuits, never a TS re-implementation. The
// secret itself is parsed by lib's `parseIdentitySecretKey`
// (`VAULT_USER_SECRET_KEY`, defaulting to the `USER_SEED` bytes).

import { bytesToHex } from "@sig-net/midnight";
import { pureCircuits } from "@midnight-examples/erc20-vault-contract";
import { parseIdentitySecretKey } from "@midnight-examples/lib";
import { resolveUserSeed } from "@midnight-examples/test-harness";

/** The caller identity every vault interaction is bound to. */
export interface UserIdentity {
  /** The 32-byte secret answering the vault's `callerSecretKey` witness. */
  readonly secretKey: Uint8Array;
  /**
   * `userCommitment(secretKey)`: the only identity form that reaches the
   * ledger. Doubles as the MPC derivation path of the user's deposit events
   * (the path field is 32 opaque bytes of the contract's choosing, and the
   * vault chooses the caller's commitment; the contract recomputes it
   * in-circuit, so it is never a circuit argument).
   */
  readonly commitment: Uint8Array;
  /** Canonical lowercase hex of the commitment (no 0x prefix). */
  readonly commitmentHex: string;
  /**
   * The commitment as the MPC's epsilon-derivation PATH STRING: the fakenet
   * reads the 32 opaque path bytes as UTF-8 with NUL bytes stripped before
   * composing the derivation string, so deriving the user's EVM account
   * off-chain must apply the exact same (lossy but deterministic) reading.
   */
  readonly pathString: string;
}

/**
 * Read 32 opaque path bytes the way the MPC's epsilon derivation does:
 * decode as UTF-8 (invalid sequences become U+FFFD, deterministically) and
 * strip NUL bytes. Mirror of the fakenet responder's `getPath`.
 *
 * @param path - The 32 path bytes as stored in the event record.
 * @returns The derivation path string.
 */
export function pathStringOfBytes(path: Uint8Array): string {
  return Buffer.from(path).toString("utf8").replace(/\0/g, "");
}

/**
 * Derive the user's vault identity from the environment: the secret from
 * `VAULT_USER_SECRET_KEY` (falling back to the `USER_SEED` bytes), the
 * commitment via the vault's compiled `userCommitment` circuit, and the MPC
 * derivation path string via the fakenet's path reading.
 *
 * @param env - The environment holding the identity secret (or seed).
 * @returns The derived identity.
 * @throws If the identity secret/seed is malformed.
 */
export function resolveUserIdentity(env: NodeJS.ProcessEnv): UserIdentity {
  const secretKey = parseIdentitySecretKey("VAULT_USER_SECRET_KEY", env, resolveUserSeed(env));
  const commitment = pureCircuits.userCommitment(secretKey);
  return {
    secretKey,
    commitment,
    commitmentHex: bytesToHex(commitment),
    pathString: pathStringOfBytes(commitment),
  };
}
