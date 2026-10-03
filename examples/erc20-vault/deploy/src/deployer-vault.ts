// Joining a deployed vault as its deployer, for the entrypoints that call a
// deployer-gated circuit without a session: `initialise` and `addAllowedToken`.
// The deployer identity resolves exactly as the deploy resolves it
// (`VAULT_DEPLOYER_SECRET_KEY`, falling back to the `DEPLOYER_SEED` bytes), so
// the caller and the commitment sealed at deploy agree by construction.

import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
// midnight-js reads a process-global network id (unlike compact-js, which
// takes it explicitly), so joining a deployed contract needs it set.
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import {
  deriveAccountKeys,
  ensureFeeReady,
  envOrUndefined,
  getDeployConfig,
  getFaucetUrl,
  parseIdentitySecretKey,
  withSyncedWalletFacade,
} from "@sig-net/midnight-contract-deploy";
import {
  createVaultPrivateState,
  type DeployedVaultContract,
  VAULT_PRIVATE_STATE_ID,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { vaultCompiledContract } from "./vault-contract-binding.ts";
import { buildVaultProviders } from "./vault-providers.ts";

/**
 * The vault a deployer entrypoint acts on: `contractAddress` when given and
 * not blank, else `MIDNIGHT_VAULT_CONTRACT_ADDRESS`. A blank explicit address
 * counts as absent, so a caller threading an unset value through still gets
 * the environment's answer (or its error).
 *
 * @param env - The environment to fall back to.
 * @param contractAddress - The explicitly named vault, if any.
 * @param purpose - What the address is for, completing "it names the vault to ...".
 * @returns The vault contract address.
 * @throws {Error} If neither names a vault.
 */
export function resolveVaultContractAddress(
  env: Record<string, string | undefined>,
  contractAddress: string | undefined,
  purpose: string,
): string {
  const explicitAddress = contractAddress?.trim();
  if (explicitAddress !== undefined && explicitAddress !== "") return explicitAddress;
  const fromEnv = envOrUndefined(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  if (!fromEnv) {
    throw new Error(
      `MIDNIGHT_VAULT_CONTRACT_ADDRESS is required: it names the vault to ${purpose} ` +
        "(the deploy prints it)",
    );
  }
  return fromEnv;
}

/**
 * Sync the deployer wallet, make sure it can pay fees, join the vault at
 * `vaultContractAddress` with the deployer identity as private state, and run
 * `action` against it.
 *
 * @param env - The environment: the deploy SDK's Midnight node configuration,
 *   `DEPLOYER_SEED` and `VAULT_DEPLOYER_SECRET_KEY`.
 * @param vaultContractAddress - The vault to join.
 * @param action - The deployer's calls, given the joined vault and the provider to read its
 *   ledger through.
 * @returns Whatever `action` returns.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no spendable DUST appears after registering the wallet's
 *   NIGHT, no contract answers at the address, or `action` throws.
 */
export async function withDeployerVault<T>(
  env: Record<string, string | undefined>,
  vaultContractAddress: string,
  action: (vault: DeployedVaultContract, publicDataProvider: PublicDataProvider) => Promise<T>,
): Promise<T> {
  const deployConfig = getDeployConfig(env);
  const nodeConfig = deployConfig.midnightNodeConfig;
  setNetworkId(nodeConfig.networkId);

  const secretKey = parseIdentitySecretKey(
    "VAULT_DEPLOYER_SECRET_KEY",
    env,
    deployConfig.deployerSeed,
  );
  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, nodeConfig.networkId);

  return withSyncedWalletFacade(accountKeys, nodeConfig, async (facade, state) => {
    await ensureFeeReady(
      facade,
      accountKeys,
      state,
      nodeConfig.networkId,
      getFaucetUrl(env, nodeConfig.networkId),
    );
    const providers = buildVaultProviders(facade, accountKeys, nodeConfig);
    const vault = await findDeployedContract(providers, {
      contractAddress: vaultContractAddress,
      compiledContract: vaultCompiledContract,
      privateStateId: VAULT_PRIVATE_STATE_ID,
      initialPrivateState: createVaultPrivateState(secretKey),
    });
    return action(vault, providers.publicDataProvider);
  });
}
