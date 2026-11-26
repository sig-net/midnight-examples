// `addAllowedTronToken`: the deployer lists each TRC-20 `TRON_ALLOWED_TOKENS` names, with
// its fees and its factor. A listing is permanent and its factor fixed, so a token already
// listed is skipped, and one listed with another factor fails the run before any call.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import { envOrUndefined, type WalletRegistry } from "@sig-net/midnight-contract-deploy";
import {
  type DeployedVaultContract,
  evmAddressBytes,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import { feeRunSettings, formatTokenFees } from "./fee-config.ts";
import { resolveTronTokenListings, type TronTokenListings } from "./tron-targets.ts";

/**
 * Call the vault's `addAllowedTronToken` circuit for each of `tokens` the vault does not
 * list yet. The caller must hold the DEPLOYER identity.
 *
 * @param vault - The joined vault contract handle
 * @param publicDataProvider - The provider to read the vault's current ledger state through
 * @param vaultContractAddress - The vault contract's address
 * @param tokens - The TRC-20s to list, from {@link resolveTronTokenListings}
 * @returns The TRC-20s this call added
 * @throws {Error} If the vault is not initialised, or lists one of `tokens` with another factor
 */
export async function addAllowedTronTokensToVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  tokens: TronTokenListings,
): Promise<readonly string[]> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  for (const [token, { factor }] of tokens) {
    const tokenBytes = evmAddressBytes(token);
    if (!state.allowedTronTokens.member(tokenBytes)) continue;
    const listed = state.allowedTronTokens.lookup(tokenBytes).factor;
    if (listed !== factor) {
      throw new Error(
        `TRC-20 ${token} is listed with factor ${String(listed)}, not ${String(factor)}: a ` +
          "listing's factor is fixed, so set TRON_TOKEN_FACTORS to the listed one",
      );
    }
  }
  const added: string[] = [];
  for (const [token, { fees, factor }] of tokens) {
    const tokenBytes = evmAddressBytes(token);
    if (state.allowedTronTokens.member(tokenBytes)) {
      console.log(`TRC-20 ${token} is already allowed, skipping`);
      continue;
    }
    const result = await vault.callTx.addAllowedTronToken(tokenBytes, fees, factor);
    console.log(
      `allowed TRC-20 ${token} (factor ${String(factor)}, fees ${formatTokenFees(fees)} coin ` +
        `units) in tx ${result.public.txId}`,
    );
    added.push(token);
  }
  return added;
}

/**
 * Join a deployed vault as the deployer and list every TRC-20 `TRON_ALLOWED_TOKENS` names
 * that it does not list yet, with the fees `VAULT_TOKEN_FEES` or the flat `VAULT_FEE_*`
 * variables give it in coin units and the factor `TRON_TOKEN_FACTORS` gives it (1 when
 * unnamed). An empty list starts no wallet.
 *
 * @param env - The environment
 * @param contractAddress - The vault to configure
 * @param wallets - A registry to take the deployer wallet from
 * @returns The TRC-20s this call added
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor DUST
 * @throws {Error} If no contract address is available, the listing is refused as
 *   {@link resolveTronTokenListings} refuses it, or the vault lists a token with another
 *   factor
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
  const tokens = resolveTronTokenListings(env);
  if (tokens.size === 0) {
    console.log("TRON_ALLOWED_TOKENS lists no TRC-20s, nothing to allow");
    return [];
  }
  return withDeployerVault(
    env,
    vaultContractAddress,
    "allowing TRC-20s on",
    {
      TRON_ALLOWED_TOKENS: [...tokens.keys()].join(","),
      TRON_TOKEN_FACTORS: envOrUndefined(env, "TRON_TOKEN_FACTORS"),
      ...feeRunSettings(env),
    },
    (vault, publicDataProvider) =>
      addAllowedTronTokensToVaultContract(vault, publicDataProvider, vaultContractAddress, tokens),
    wallets,
  );
}
