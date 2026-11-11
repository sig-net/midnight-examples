// Joining a deployed vault as its deployer, for the entrypoints that call a
// deployer-gated circuit without a session: `initialise`, `addAllowedToken` and
// `setTokenFees`.
// The deployer identity resolves exactly as the deploy resolves it
// (`VAULT_DEPLOYER_SECRET_KEY`, falling back to the `DEPLOYER_SEED` bytes), so
// the caller and the commitment sealed at deploy agree by construction.

import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import {
  ensureFeeReady,
  envOrUndefined,
  getDeployConfig,
  getFaucetUrl,
  parseIdentitySecretKey,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  createVaultPrivateState,
  type DeployedVaultContract,
  VAULT_PRIVATE_STATE_ID,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import {
  announceDeployerRun,
  logDeployerBalance,
  type VaultRunSettings,
} from "./deployer-run-report.ts";
import { assertVaultKeysPresent, vaultCompiledContract } from "./vault-contract-binding.ts";
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
 * Announce the run, sync the deployer wallet, log its balance, make sure it can pay fees, join the vault at
 * `vaultContractAddress` with the deployer identity as private state, and run
 * `action` against it.
 *
 * @param env - The environment: the deploy SDK's Midnight node configuration,
 *   `DEPLOYER_SEED` and `VAULT_DEPLOYER_SECRET_KEY`.
 * @param vaultContractAddress - The vault to join.
 * @param activity - What the run does to the vault, completing "<activity> erc20-vault
 *   <address>" in the run's opening log line.
 * @param vaultSettings - The vault-specific settings the run reads, tabulated under that line.
 * @param action - The deployer's calls, given the joined vault and the provider to read its
 *   ledger through.
 * @param wallets - A registry to take the deployer wallet from, when the caller keeps wallets
 *   open across steps. Without one a private registry is opened for this run and closed after it.
 * @returns Whatever `action` returns.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If the vault's zk keys are missing, no spendable DUST appears
 *   after registering the wallet's NIGHT, no contract answers at the address,
 *   or `action` throws.
 */
export async function withDeployerVault<T>(
  env: Record<string, string | undefined>,
  vaultContractAddress: string,
  activity: string,
  vaultSettings: VaultRunSettings,
  action: (vault: DeployedVaultContract, publicDataProvider: PublicDataProvider) => Promise<T>,
  wallets?: WalletRegistry,
): Promise<T> {
  assertVaultKeysPresent();
  const deployConfig = getDeployConfig(env);
  const nodeConfig = deployConfig.midnightNodeConfig;

  const secretKey = parseIdentitySecretKey(
    "VAULT_DEPLOYER_SECRET_KEY",
    env,
    deployConfig.deployerSeed,
  );
  const registry = wallets ?? new WalletRegistry(nodeConfig);

  announceDeployerRun(
    `${activity} erc20-vault ${vaultContractAddress} on ${nodeConfig.networkId}`,
    env,
    deployConfig,
    vaultSettings,
    wallets === undefined,
  );
  try {
    const { facade, keys } = await registry.wallet(deployConfig.deployerSeed, "deployer");
    const state = await facade.waitForSyncedState();
    logDeployerBalance(state, keys, nodeConfig.networkId);
    await ensureFeeReady(
      facade,
      keys,
      state,
      nodeConfig.networkId,
      getFaucetUrl(env, nodeConfig.networkId),
    );
    const providers = buildVaultProviders(facade, keys, nodeConfig);
    const vault = await findDeployedContract(providers, {
      contractAddress: vaultContractAddress,
      compiledContract: vaultCompiledContract,
      privateStateId: VAULT_PRIVATE_STATE_ID,
      initialPrivateState: createVaultPrivateState(secretKey),
    });
    return await action(vault, providers.publicDataProvider);
  } finally {
    if (wallets === undefined) await registry.close();
  }
}
