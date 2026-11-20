import {
  addAllowedTronTokensToVaultContract,
  type TokenFeesByToken,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * @param context - The flow context
 * @param tokens - The TRC-20s to allow
 * @returns The TRC-20s this call added
 * @throws {Error} If the vault is not initialised
 */
export async function addAllowedTronTokens(
  context: VaultContext,
  tokens: TokenFeesByToken,
): Promise<readonly string[]> {
  return addAllowedTronTokensToVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    tokens,
  );
}
