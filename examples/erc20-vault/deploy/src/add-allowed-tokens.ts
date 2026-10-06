// `addAllowedToken`: the deployer's call adding an ERC20 to the set the vault
// lets users deposit and swap into. `initialise` allows the stata underlying
// itself, so every other ERC20 a deployment moves must be added here before
// its first deposit or swap. The set only grows: no circuit removes a token.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import {
  type DeployedVaultContract,
  evmAddressBytes,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import { resolveAllowedTokens } from "./evm-targets.ts";

/**
 * Call the vault's `addAllowedToken` circuit once for each of `tokens` the
 * ledger does not already allow, so a rerun against a kept vault submits
 * nothing for the tokens an earlier run added.
 *
 * The caller must hold the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param tokens - The ERC20s to allow, as 0x hex, from {@link resolveAllowedTokens}.
 * @returns The ERC20s this call added, in `tokens` order.
 * @throws {Error} If the vault is not initialised, a token is malformed, or the circuit
 *   rejects the caller.
 */
export async function addAllowedTokensToVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  tokens: readonly string[],
): Promise<readonly string[]> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  const added: string[] = [];
  for (const token of tokens) {
    const tokenBytes = evmAddressBytes(token);
    if (state.allowedTokens.member(tokenBytes)) {
      console.log(`ERC20 ${token} is already allowed, skipping`);
      continue;
    }
    const result = await vault.callTx.addAllowedToken(tokenBytes);
    console.log(`allowed ERC20 ${token} in tx ${result.public.txId}`);
    added.push(token);
  }
  return added;
}

/**
 * Join a deployed vault as the deployer and allow every ERC20
 * `EVM_ALLOWED_TOKENS` lists: the standalone counterpart of
 * {@link addAllowedTokensToVaultContract} for entrypoints that hold no session.
 * An empty list starts no wallet.
 *
 * @param env - The environment: `EVM_ALLOWED_TOKENS` and everything {@link withDeployerVault}
 *   reads. Defaults to `process.env`.
 * @param contractAddress - The vault to configure. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns The ERC20s this call added.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no contract address is available, `EVM_ALLOWED_TOKENS` is malformed,
 *   the vault is not initialised, or the circuit rejects the caller.
 */
export async function addAllowedTokensToVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<readonly string[]> {
  const vaultContractAddress = resolveVaultContractAddress(
    env,
    contractAddress,
    "add allowed ERC20s to",
  );
  const tokens = resolveAllowedTokens(env);
  if (tokens.length === 0) {
    console.log("EVM_ALLOWED_TOKENS lists no ERC20s, nothing to allow");
    return [];
  }
  return withDeployerVault(env, vaultContractAddress, (vault, publicDataProvider) =>
    addAllowedTokensToVaultContract(vault, publicDataProvider, vaultContractAddress, tokens),
  );
}
