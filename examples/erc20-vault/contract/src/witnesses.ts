// Handwritten witnesses live beside the contract they serve. The vault's
// identity model: callerSecretKey supplies the user's secret from private
// state; only its commitment (userCommitment in the contract) ever reaches
// the ledger.

import type { Witnesses } from "./managed/erc20-vault/contract/index.js";

/** Private state carried through vault circuit calls. */
export interface VaultPrivateState {
  /** The caller's 32-byte identity secret; never disclosed on-chain. */
  readonly secretKey: Uint8Array;
}

/**
 * Build the vault's private state.
 *
 * @param secretKey - The caller's 32-byte identity secret.
 * @returns A fresh private state holding `secretKey`.
 */
export const createVaultPrivateState = (secretKey: Uint8Array): VaultPrivateState => ({
  secretKey,
});

/**
 * Witness implementations, typed against the generated `Witnesses` shape.
 * `callerSecretKey` feeds the contract's identity commitment (and thereby the
 * MPC derivation path) from private state. `secondsOfMillis` divides a Tron
 * time by 1000 and `unitsOfBase` a Tron base-unit amount by its token's factor,
 * which Compact cannot; the circuit checks each quotient.
 */
export const witnesses: Witnesses<VaultPrivateState> = {
  callerSecretKey: ({ privateState }): [VaultPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
  secondsOfMillis: ({ privateState }, millis): [VaultPrivateState, bigint] => [
    privateState,
    millis / 1000n,
  ],
  unitsOfBase: ({ privateState }, base, factor): [VaultPrivateState, bigint] => [
    privateState,
    base / factor,
  ],
};
