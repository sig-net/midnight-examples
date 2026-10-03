// `addAllowedToken`: the deployer adds ERC20s to the set the vault lets users
// deposit and swap into.
//
// The circuit calls are the deploy package's `addAllowedTokensToVaultContract`,
// the same function the deploy+initialise and add-allowed-tokens entrypoints
// run. This flow is the session-shaped face of it, so the suites exercise the
// code a remote bring-up depends on.

import { addAllowedTokensToVaultContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Allow each of `tokens` the vault does not already allow, with one
 * `addAllowedToken` call per token.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field, so
 * `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this call.
 *
 * @param context - The flow context.
 * @param tokens - The ERC20s to allow, as 0x hex (the deploy package's
 *   `resolveAllowedTokens` against the env the setup pipeline populated).
 * @returns The ERC20s this call added.
 * @throws {Error} If the vault is not initialised, a token is malformed, or the circuit
 *   rejects the caller.
 */
export async function addAllowedTokens(
  context: VaultContext,
  tokens: readonly string[],
): Promise<readonly string[]> {
  return addAllowedTokensToVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    tokens,
  );
}
