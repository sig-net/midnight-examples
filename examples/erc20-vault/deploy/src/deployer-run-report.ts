// What every deployer-wallet run prints around its wallet sync: the settings
// it runs with and where each came from, the address to fund, and the synced
// wallet's balance. The node-config rows, the funding line and the balance
// formatting are the deploy SDK's, shared with the protocol contract deploys.
// The vault's own rows arrive from the flow that reads them.

import { redactUrlQuery } from "@sig-net/midnight";
import {
  accountFunding,
  type AccountKeys,
  type DeployConfig,
  deployEnvironmentTable,
  deployerFundingLine,
  type DeploySettingRow,
  DeploySettingSource,
  deriveAddresses,
  envOrUndefined,
  type FacadeState,
  formatFunding,
  formatUtxoBreakdown,
  isLocalStandaloneNetwork,
  type MidnightNodeConfig,
  type NetworkId,
} from "@sig-net/midnight-contract-deploy";

/**
 * The vault-specific settings one run reads, keyed by environment variable
 * name, each with the value the run resolved for it (undefined when nothing
 * supplies one). Secrets are left out by the flow that builds the map.
 */
export type VaultRunSettings = Readonly<Record<string, string | undefined>>;

/**
 * Log what a deployer-wallet run is about to do, the settings it runs with,
 * and, when `fundingLine` is set on a deployed network, the deployer's NIGHT
 * receive address. Call it ahead of the wallet sync, so the address can be
 * funded while the sync runs.
 *
 * @param headline - What the run does, completing "<headline> with:".
 * @param env - The environment the run reads.
 * @param deployConfig - The deploy config resolved from `env`.
 * @param vaultSettings - The vault-specific settings this run reads.
 * @param fundingLine - Whether this run opens the deployer wallet itself, so the address to
 *   fund is worth naming.
 * @throws {Error} If the deployer seed is rejected by key derivation.
 */
export function announceDeployerRun(
  headline: string,
  env: Record<string, string | undefined>,
  deployConfig: DeployConfig,
  vaultSettings: VaultRunSettings,
  fundingLine: boolean,
): void {
  console.log(`${headline} with:`);
  console.table(deployerRunSettingsTable(env, deployConfig.midnightNodeConfig, vaultSettings));
  if (fundingLine) logDeployerFundingAddress(deployConfig);
}

/**
 * Log the deployer's NIGHT receive address on a deployed network, where the
 * operator funds it by hand.
 *
 * @param deployConfig - The deploy config naming the deployer seed and the network.
 * @throws {Error} If the deployer seed is rejected by key derivation.
 */
export function logDeployerFundingAddress(deployConfig: DeployConfig): void {
  const { networkId } = deployConfig.midnightNodeConfig;
  if (!isLocalStandaloneNetwork(networkId)) {
    console.log(deployerFundingLine(deployConfig.deployerSeed, networkId));
  }
}

/**
 * Log the synced deployer wallet's balances and UTXO breakdown.
 *
 * @param state - The deployer wallet's synced state.
 * @param keys - The deployer wallet's keys.
 * @param networkId - The network the wallet's addresses are encoded for.
 */
export function logDeployerBalance(
  state: FacadeState,
  keys: AccountKeys,
  networkId: NetworkId,
): void {
  const funding = accountFunding(state, deriveAddresses(keys, networkId));
  console.log(`deployer balance: ${formatFunding(funding)}\n${formatUtxoBreakdown(state)}`);
}

/**
 * Tabulate the settings of a deployer-wallet run: the deploy SDK's node-config
 * rows followed by one row per vault setting, every URL's query values masked.
 * A vault row's source is the environment when its variable is set there, and
 * the default otherwise.
 *
 * @param env - The environment the run reads.
 * @param midnightNodeConfig - The node config resolved from `env`.
 * @param vaultSettings - The vault-specific settings this run reads.
 * @returns One row per variable, keyed by variable name.
 */
export function deployerRunSettingsTable(
  env: Record<string, string | undefined>,
  midnightNodeConfig: MidnightNodeConfig,
  vaultSettings: VaultRunSettings,
): Record<string, DeploySettingRow> {
  const vaultRows = Object.entries(vaultSettings).map(
    ([name, value]): [string, DeploySettingRow] => [
      name,
      {
        value: redactUrlQuery(value ?? "(none)"),
        source:
          envOrUndefined(env, name) === undefined
            ? DeploySettingSource.Default
            : DeploySettingSource.Environment,
      },
    ],
  );
  return { ...deployEnvironmentTable(env, midnightNodeConfig), ...Object.fromEntries(vaultRows) };
}
