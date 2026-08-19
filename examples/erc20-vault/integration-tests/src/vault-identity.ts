// The user's vault identity: secret key -> commitment -> MPC derivation path.
// Derivation calls the compiled circuits, never a TS re-implementation. The
// secret is the session's wallet seed bytes (lib's `identitySecretFromSeed`),
// so one seed is both the wallet that spends and the identity that gates.

import { pureCircuits } from "@midnight-examples/erc20-vault-contract";
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
  /**
   * Canonical lowercase hex of the commitment (no 0x prefix). Doubles as
   * the MPC's epsilon-derivation PATH STRING for the user's account: the
   * MPC renders a record's 32 path bytes as their full-width lowercase hex,
   * so the string that derives the user's EVM address off-chain is exactly
   * this rendering.
   */
  readonly commitmentHex: string;
}

/**
 * Derive the user's vault identity from the environment: the secret is the
 * session's wallet seed bytes (`MIDNIGHT_USER1_WALLET_SEED`) and the
 * commitment comes from the vault's compiled `userCommitment` circuit.
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
  };
}
