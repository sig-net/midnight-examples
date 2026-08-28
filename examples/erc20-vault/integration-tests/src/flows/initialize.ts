// `initialize`: the deployer's one-off call sealing the vault's post-deploy
// configuration into the contract, i.e. the vault's EVM address, the EVM
// chain it operates on, the contracts it trades and lends through, and the MPC
// RESPONSE key (derived from the vault's own contract address, so it cannot be
// a constructor argument). Gated in-circuit to the deployer identity.
//
// The circuit call itself is the deploy package's `initializeVaultContract`,
// the same function the stagenet deploy+initialize entrypoint runs. This flow
// is the session-shaped face of it, so the suites exercise the code a remote
// bring-up depends on.

import {
  initializeVaultContract,
  type InitializeVaultOutcome,
  type VaultInitializeConfig,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Call the vault's `initialize` circuit on the deployed contract, pinning the
 * vault's EVM address, the chain it lives on, the router/stata targets and the
 * MPC response key. After this, requests never take a chain argument and
 * responses verify against the stored key. A vault already initialized (a
 * rerun against a kept contract address) is left untouched.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field, so
 * `context` must come from a session whose wallet seed is the deployer's
 * (`MIDNIGHT_DEPLOYER_WALLET_SEED`, unless `VAULT_DEPLOYER_SECRET` overrides
 * the identity the deploy sealed).
 *
 * @param context - The flow context.
 * @param config - The resolved circuit arguments, from the deploy package's
 *   `resolveInitializeConfig` against the env the setup pipeline populated.
 * @returns Whether this call initialized the vault or found it already initialized.
 * @throws {Error} If an argument is malformed or the circuit rejects the caller.
 */
export async function initialize(
  context: VaultContext,
  config: VaultInitializeConfig,
): Promise<InitializeVaultOutcome> {
  console.log(
    `caller commitment: ${context.identity.commitmentHex} (must equal the sealed deployer)`,
  );
  return initializeVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    config,
  );
}
