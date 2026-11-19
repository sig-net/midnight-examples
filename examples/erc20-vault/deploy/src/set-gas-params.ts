// `setGasParams`: the deployer's reset of the fee envelope and the per-action
// gas limits of the transactions the vault's own EVM account signs. Each
// `VAULT_*` gas variable replaces one setting and every unset one keeps its
// ledger value, so a rerun against a vault already at those settings submits
// nothing.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import { envOrUndefined } from "@sig-net/midnight-contract-deploy";
import {
  type DeployedVaultContract,
  readVaultLedger,
  type VaultGasKind,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";

/** The gas settings the vault's `setGasParams` circuit stores. */
export interface VaultGasParams {
  /** Max total fee per gas of every vault-signed transaction, wei. */
  readonly maxFeePerGas: bigint;
  /** Max priority fee per gas of every vault-signed transaction, wei. */
  readonly maxPriorityFeePerGas: bigint;
  /** The gas limit of each kind of vault-signed transaction. */
  readonly gasLimits: Readonly<Record<VaultGasKind, bigint>>;
}

/** The variable naming the max total fee per gas, in wei. */
export const VAULT_MAX_FEE_PER_GAS_VARIABLE = "VAULT_MAX_FEE_PER_GAS";

/** The variable naming the max priority fee per gas, in wei. */
export const VAULT_MAX_PRIORITY_FEE_PER_GAS_VARIABLE = "VAULT_MAX_PRIORITY_FEE_PER_GAS";

/** The variable naming each kind's gas limit. */
export const VAULT_GAS_LIMIT_VARIABLES: Readonly<Record<VaultGasKind, string>> = {
  withdraw: "VAULT_GAS_LIMIT_WITHDRAW",
  approve: "VAULT_GAS_LIMIT_APPROVE",
  swap: "VAULT_GAS_LIMIT_SWAP",
  supply: "VAULT_GAS_LIMIT_SUPPLY",
  redeem: "VAULT_GAS_LIMIT_REDEEM",
};

const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

// One gas variable: the positive integer it names, or `current` when unset.
function resolveGasSetting(
  env: Record<string, string | undefined>,
  name: string,
  current: bigint,
  max: bigint,
): bigint {
  const text = envOrUndefined(env, name);
  if (text === undefined) return current;
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${name} must be a positive integer, got "${text}".`);
  }
  const setting = BigInt(text);
  if (setting > max) {
    throw new Error(`${name} must be at most ${String(max)}, got ${text}.`);
  }
  return setting;
}

/**
 * The gas settings a run asks for: `current` with each set gas variable
 * replacing its setting.
 *
 * @param env - The environment: {@link VAULT_MAX_FEE_PER_GAS_VARIABLE},
 *   {@link VAULT_MAX_PRIORITY_FEE_PER_GAS_VARIABLE} and {@link VAULT_GAS_LIMIT_VARIABLES}.
 * @param current - The settings the vault holds, which every unset variable keeps.
 * @returns The settings to store.
 * @throws {Error} If a variable is not a positive integer, exceeds the circuit's width for it
 *   (a `Uint<128>` fee, a `Uint<64>` limit), or the priority fee exceeds the total fee.
 */
export function resolveVaultGasParams(
  env: Record<string, string | undefined>,
  current: VaultGasParams,
): VaultGasParams {
  const limit = (kind: VaultGasKind): bigint =>
    resolveGasSetting(env, VAULT_GAS_LIMIT_VARIABLES[kind], current.gasLimits[kind], UINT64_MAX);
  const params: VaultGasParams = {
    maxFeePerGas: resolveGasSetting(
      env,
      VAULT_MAX_FEE_PER_GAS_VARIABLE,
      current.maxFeePerGas,
      UINT128_MAX,
    ),
    maxPriorityFeePerGas: resolveGasSetting(
      env,
      VAULT_MAX_PRIORITY_FEE_PER_GAS_VARIABLE,
      current.maxPriorityFeePerGas,
      UINT128_MAX,
    ),
    gasLimits: {
      withdraw: limit("withdraw"),
      approve: limit("approve"),
      swap: limit("swap"),
      supply: limit("supply"),
      redeem: limit("redeem"),
    },
  };
  if (params.maxPriorityFeePerGas > params.maxFeePerGas) {
    throw new Error(
      `${VAULT_MAX_PRIORITY_FEE_PER_GAS_VARIABLE} (${String(params.maxPriorityFeePerGas)}) ` +
        `cannot exceed ${VAULT_MAX_FEE_PER_GAS_VARIABLE} (${String(params.maxFeePerGas)}).`,
    );
  }
  return params;
}

/**
 * Render gas settings for a log line.
 *
 * @param params - The settings to render.
 * @returns The fee envelope in wei followed by each kind's gas limit.
 */
export function formatVaultGasParams(params: VaultGasParams): string {
  const { withdraw, approve, swap, supply, redeem } = params.gasLimits;
  return (
    `max fee ${String(params.maxFeePerGas)} wei, ` +
    `max priority fee ${String(params.maxPriorityFeePerGas)} wei, gas limits ` +
    `withdraw ${String(withdraw)}, approve ${String(approve)}, swap ${String(swap)}, ` +
    `supply ${String(supply)}, redeem ${String(redeem)}`
  );
}

// Two settings holding the same figure everywhere.
function sameGasParams(a: VaultGasParams, b: VaultGasParams): boolean {
  return formatVaultGasParams(a) === formatVaultGasParams(b);
}

/**
 * Call the vault's `setGasParams` circuit with the settings `env` asks for,
 * unless the ledger already holds them. A request in flight keeps the gas it
 * was started with, so only requests started afterwards take the new settings.
 *
 * The caller must hold the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param env - The environment naming the settings, as {@link resolveVaultGasParams} reads it.
 * @returns The settings the vault holds after the call.
 * @throws {Error} If the vault is not initialised, a variable is malformed, or the circuit
 *   rejects the caller.
 */
export async function setGasParamsOnVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  env: Record<string, string | undefined>,
): Promise<VaultGasParams> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  const current: VaultGasParams = {
    maxFeePerGas: state.vaultMaxFeePerGas,
    maxPriorityFeePerGas: state.vaultMaxPriorityFeePerGas,
    gasLimits: state.vaultGasLimits,
  };
  const params = resolveVaultGasParams(env, current);
  if (sameGasParams(current, params)) {
    console.log(`vault gas settings already ${formatVaultGasParams(current)}, skipping`);
    return current;
  }
  const result = await vault.callTx.setGasParams(
    params.maxFeePerGas,
    params.maxPriorityFeePerGas,
    params.gasLimits.withdraw,
    params.gasLimits.approve,
    params.gasLimits.swap,
    params.gasLimits.supply,
    params.gasLimits.redeem,
  );
  console.log(
    `vault gas settings were ${formatVaultGasParams(current)}\n` +
      `vault gas settings set to ${formatVaultGasParams(params)} in tx ${result.public.txId}`,
  );
  return params;
}

/**
 * Join a deployed vault as the deployer and store the gas settings the
 * environment asks for: the standalone counterpart of
 * {@link setGasParamsOnVaultContract} for entrypoints that hold no session.
 *
 * @param env - The environment: the gas variables {@link resolveVaultGasParams} reads and
 *   everything {@link withDeployerVault} reads. Defaults to `process.env`.
 * @param contractAddress - The vault to reset. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns The settings the vault holds after the call.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no contract address is available, a gas variable is malformed, the
 *   vault is not initialised, or the circuit rejects the caller.
 */
export async function setGasParamsOnVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<VaultGasParams> {
  const vaultContractAddress = resolveVaultContractAddress(
    env,
    contractAddress,
    "reset the gas settings of",
  );
  const variables = [
    VAULT_MAX_FEE_PER_GAS_VARIABLE,
    VAULT_MAX_PRIORITY_FEE_PER_GAS_VARIABLE,
    ...Object.values(VAULT_GAS_LIMIT_VARIABLES),
  ];
  return withDeployerVault(
    env,
    vaultContractAddress,
    "resetting the gas settings of",
    Object.fromEntries(variables.map((name) => [name, envOrUndefined(env, name)])),
    (vault, publicDataProvider) =>
      setGasParamsOnVaultContract(vault, publicDataProvider, vaultContractAddress, env),
  );
}
