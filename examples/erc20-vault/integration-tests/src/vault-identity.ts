// The user's vault identity: secret key → commitment → MPC derivation path.
// Derivation calls the compiled circuits — never a TS re-implementation. The
// secret itself is parsed by lib's `parseIdentitySecretKey`
// (`VAULT_USER_SECRET_KEY`, defaulting to the `USER_SEED` bytes).

import { bytesToHex, signetPathOfCommitment } from "@sig-net/midnight";
import { pureCircuits } from "@midnight-examples/erc20-vault-contract";
import { parseIdentitySecretKey } from "@midnight-examples/lib";
import { resolveUserSeed } from "@midnight-examples/test-harness";

/** The caller identity every vault interaction is bound to. */
export interface UserIdentity {
  /** The 32-byte secret answering the vault's `callerSecretKey` witness. */
  readonly secretKey: Uint8Array;
  /** `userCommitment(secretKey)` — the only identity form that reaches the ledger. */
  readonly commitment: Uint8Array;
  /** Canonical lowercase hex of the commitment (no 0x prefix). */
  readonly commitmentHex: string;
  /** The MPC derivation path: the commitment hex, zero-padded to the path width. */
  readonly path: Uint8Array;
}

/**
 * Derive the user's vault identity from the environment: the secret from
 * `VAULT_USER_SECRET_KEY` (falling back to the `USER_SEED` bytes), the
 * commitment via the vault's compiled `userCommitment` circuit, and the MPC
 * derivation path via signet-midnight's canonical path construction.
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
    path: signetPathOfCommitment(commitment),
  };
}
