// The user's vault identity: secret key -> commitment -> MPC derivation path.
// Derivation calls the compiled circuits, never a TS re-implementation. The
// secret itself is parsed by lib's `parseIdentitySecret`
// (`VAULT_USER_SECRET`, defaulting to the `MIDNIGHT_USER1_WALLET_SEED` bytes).

import { bytesToHex } from "@sig-net/midnight";
import { pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";
import { parseIdentitySecret } from "@sig-net/midnight-examples-lib";
import { resolveUserSeed } from "@sig-net/midnight-examples-test-harness";

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
 * Derive the user's vault identity from the environment: the secret from
 * `VAULT_USER_SECRET` (falling back to the `MIDNIGHT_USER1_WALLET_SEED` bytes) and the
 * commitment via the vault's compiled `userCommitment` circuit.
 *
 * @param env - The environment holding the identity secret (or seed).
 * @returns The derived identity.
 * @throws {ParseError} If the identity secret/seed is malformed.
 */
export function resolveUserIdentity(env: NodeJS.ProcessEnv): UserIdentity {
  const secretKey = parseIdentitySecret("VAULT_USER_SECRET", env, resolveUserSeed(env));
  const commitment = pureCircuits.userCommitment(secretKey);
  return {
    secretKey,
    commitment,
    commitmentHex: bytesToHex(commitment),
  };
}
