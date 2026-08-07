// The user's vault identity: secret key -> commitment -> MPC derivation path.
// Derivation calls the compiled circuits, never a TS re-implementation. The
// secret is the session's wallet seed bytes (lib's `identitySecretFromSeed`),
// so one seed is both the wallet that spends and the identity that gates.

import { pathStringOfBytes, pureCircuits } from "@midnight-examples/erc20-vault-contract";
import { identitySecretFromSeed } from "@midnight-examples/lib";
import { resolveUserSeed } from "@midnight-examples/test-harness";
import { bytesToHex } from "@sig-net/midnight";

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
 * Derive the user's vault identity from the environment: the secret is the
 * session's wallet seed bytes (`MIDNIGHT_USER1_WALLET_SEED`), the commitment
 * comes from the vault's compiled `userCommitment` circuit, and the MPC
 * derivation path string from the fakenet's path reading.
 *
 * @param env - The environment holding the session's wallet seed.
 * @returns The derived identity.
 * @throws {ParseError} If the seed is malformed or not exactly 32 bytes of hex.
 */
export function resolveUserIdentity(env: NodeJS.ProcessEnv): UserIdentity {
  const secretKey = identitySecretFromSeed(resolveUserSeed(env));
  const commitment = pureCircuits.userCommitment(secretKey);
  return {
    secretKey,
    commitment,
    commitmentHex: bytesToHex(commitment),
    pathString: pathStringOfBytes(commitment),
  };
}
