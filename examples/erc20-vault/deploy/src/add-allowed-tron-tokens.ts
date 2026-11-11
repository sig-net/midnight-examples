import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";
import {
  type DeployedVaultContract,
  evmAddressBytes,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import {
  feeRunSettings,
  formatTokenFees,
  resolveTokenFeesFor,
  type TokenFeesByToken,
} from "./fee-config.ts";
import { resolveAllowedTronTokens } from "./tron-targets.ts";

/**
 * @param vault - The joined vault contract handle
 * @param publicDataProvider - The provider to read the vault's current ledger state through
 * @param vaultContractAddress - The vault contract's address
 * @param tokens - The TRC-20s to allow
 * @returns The TRC-20s this call added
 * @throws {Error} If the vault is not initialised
 */
export async function addAllowedTronTokensToVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  tokens: TokenFeesByToken,
): Promise<readonly string[]> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  const added: string[] = [];
  for (const [token, fees] of tokens) {
    const tokenBytes = evmAddressBytes(token);
    if (state.allowedTronTokens.member(tokenBytes)) {
      console.log(`TRC-20 ${token} is already allowed, skipping`);
      continue;
    }
    const result = await vault.callTx.addAllowedTronToken(tokenBytes, fees);
    console.log(
      `allowed TRC-20 ${token} (fees ${formatTokenFees(fees)}) in tx ${result.public.txId}`,
    );
    added.push(token);
  }
  return added;
}

/**
 * @param env - The environment
 * @param contractAddress - The vault to configure
 * @param wallets - A registry to take the deployer wallet from
 * @returns The TRC-20s this call added
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor DUST
 * @throws {Error} If no contract address is available
 */
export async function addAllowedTronTokensToVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
  wallets?: WalletRegistry,
): Promise<readonly string[]> {
  const vaultContractAddress = resolveVaultContractAddress(
    env,
    contractAddress,
    "add allowed TRC-20s to",
  );
  const allowedTronTokens = resolveAllowedTronTokens(env);
  const tokens = resolveTokenFeesFor(env, allowedTronTokens);
  if (tokens.size === 0) {
    console.log("TRON_ALLOWED_TOKENS lists no TRC-20s, nothing to allow");
    return [];
  }
  return withDeployerVault(
    env,
    vaultContractAddress,
    "allowing TRC-20s on",
    { TRON_ALLOWED_TOKENS: allowedTronTokens.join(","), ...feeRunSettings(env) },
    (vault, publicDataProvider) =>
      addAllowedTronTokensToVaultContract(vault, publicDataProvider, vaultContractAddress, tokens),
    wallets,
  );
}
