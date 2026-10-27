// `setTokenFees`: the deployer's repricing of the tokens `VAULT_TOKEN_FEES`
// names, each to the fees it gives in that token's base units, the call a
// scheduled off-chain job makes once it has recomputed the fees from current
// gas and token prices. A token already at its fees is left alone, so a rerun
// submits nothing.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import {
  type DeployedVaultContract,
  evmAddressBytes,
  readVaultLedger,
  type TokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import { formatTokenFees, resolveTokenFeesByToken, type TokenFeesByToken } from "./fee-config.ts";

// Two fee structs holding the same figure for every action.
function sameFees(a: TokenFees, b: TokenFees): boolean {
  return (
    a.withdraw === b.withdraw && a.swap === b.swap && a.supply === b.supply && a.redeem === b.redeem
  );
}

/**
 * Call the vault's `setTokenFees` circuit for each of `tokens` whose ledger fees
 * differ from the ones given, so a rerun against a vault already at those fees
 * submits nothing. Every token must already be allowed: the circuit refuses an
 * unallowed one, and the check here fails before any call is submitted.
 *
 * The caller must hold the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param tokens - Each ERC20 to reprice with its new fees, from {@link resolveTokenFeesByToken}.
 * @returns The ERC20s this call repriced, as lowercased 0x hex in `tokens` order.
 * @throws {Error} If the vault is not initialised, a token is not allowed, or the circuit
 *   rejects the caller.
 */
export async function setTokenFeesOnVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  tokens: TokenFeesByToken,
): Promise<readonly string[]> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  for (const token of tokens.keys()) {
    if (!state.allowedTokens.member(evmAddressBytes(token))) {
      throw new Error(
        `the vault does not allow ERC20 ${token}: run \`yarn add-allowed-tokens:erc20-vault\` first`,
      );
    }
  }
  const repriced: string[] = [];
  for (const [token, fees] of tokens) {
    const tokenBytes = evmAddressBytes(token);
    if (sameFees(state.allowedTokens.lookup(tokenBytes).fees, fees)) {
      console.log(`ERC20 ${token} already charges ${formatTokenFees(fees)}, skipping`);
      continue;
    }
    const result = await vault.callTx.setTokenFees(tokenBytes, fees);
    console.log(`repriced ERC20 ${token} to ${formatTokenFees(fees)} in tx ${result.public.txId}`);
    repriced.push(token);
  }
  return repriced;
}

/**
 * Join a deployed vault as the deployer and reprice every token
 * `VAULT_TOKEN_FEES` names to the fees it gives: the standalone counterpart of
 * {@link setTokenFeesOnVaultContract} for entrypoints that hold no session. An
 * empty map starts no wallet.
 *
 * @param env - The environment: `VAULT_TOKEN_FEES` and everything {@link withDeployerVault}
 *   reads. Defaults to `process.env`.
 * @param contractAddress - The vault to reprice. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns The ERC20s this call repriced.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no contract address is available, `VAULT_TOKEN_FEES` is malformed, the
 *   vault is not initialised, a token is not allowed, or the circuit rejects the caller.
 */
export async function setTokenFeesOnVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<readonly string[]> {
  const vaultContractAddress = resolveVaultContractAddress(env, contractAddress, "reprice");
  const tokens = resolveTokenFeesByToken(env);
  if (tokens.size === 0) {
    console.log("VAULT_TOKEN_FEES prices no ERC20s, nothing to reprice");
    return [];
  }
  return withDeployerVault(env, vaultContractAddress, (vault, publicDataProvider) =>
    setTokenFeesOnVaultContract(vault, publicDataProvider, vaultContractAddress, tokens),
  );
}
