// `addAllowedTronToken`: the deployer lists TRC-20s, each with its fees and fixed factor.
//
// The circuit calls are the deploy package's `addAllowedTronTokensToVaultContract`, the
// same function the add-allowed-tron-tokens entrypoint runs. This flow is the
// session-shaped face of it.
import {
  addAllowedTronTokensToVaultContract,
  type TronTokenListings,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * List each of `tokens` the vault does not list yet. The caller must be the DEPLOYER
 * identity.
 *
 * @param context - The flow context
 * @param tokens - The TRC-20s to list, with their fees and factors
 * @returns The TRC-20s this call added
 * @throws {Error} If the vault is not initialised, lists a token with another factor, or the
 *   circuit rejects the caller
 */
export async function addAllowedTronTokens(
  context: VaultContext,
  tokens: TronTokenListings,
): Promise<readonly string[]> {
  return addAllowedTronTokensToVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    tokens,
  );
}
