// `initialise`: the deployer's one-off call sealing the vault's post-deploy
// configuration into the contract: the vault's own EVM address, the EVM chain
// it operates on, the contracts it trades and lends through, and the MPC
// RESPONSE key. The EVM address and the response key both derive from the
// vault's own contract address, so neither can be a constructor argument;
// the circuit gates the call on the deployer identity sealed at deploy time,
// which is what stops anyone else pointing a fresh vault at their own address.

import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
// midnight-js reads a process-global network id (unlike compact-js, which
// takes it explicitly), so joining a deployed contract needs it set.
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import {
  asciiPadded,
  CAIP2_ID_BYTES,
  deriveMidnightResponseKey,
  formatSecp256k1PublicKey,
  parseSecp256k1PublicKey,
} from "@sig-net/midnight";
import {
  deriveAccountKeys,
  envOrUndefined,
  getDeployConfig,
  parseIdentitySecretKey,
  withSyncedWalletFacade,
} from "@sig-net/midnight-contract-deploy";
import {
  createVaultPrivateState,
  type DeployedVaultContract,
  deriveVaultEvmAddress,
  evmAddressBytes,
  readVaultLedger,
  VAULT_PRIVATE_STATE_ID,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveEvmTargets, type VaultEvmTargets } from "./evm-targets.ts";
import { vaultCompiledContract } from "./vault-contract-binding.ts";
import { buildVaultProviders } from "./vault-providers.ts";

/** What an {@link initialiseVaultContract} call did. */
export enum InitialiseVaultOutcome {
  /** The initialise circuit ran and sealed the configuration in this call. */
  Initialised = "initialised",
  /** The ledger already reported the vault initialised; nothing was submitted. */
  AlreadyInitialised = "already-initialised",
}

/** Every argument the vault's `initialise` circuit takes, fully resolved. */
export interface VaultInitialiseConfig {
  /** The vault's own derived EVM account (20-byte 0x hex), the sender of its EVM transactions. */
  readonly vaultEvmAddress: string;
  /** The Uniswap SwapRouter02 the swap circuits call. */
  readonly routerAddress: string;
  /** The Aave underlying token the supply circuit lends. */
  readonly stataUnderlyingAddress: string;
  /** The ERC-4626 wrapper the supply/redeem circuits mint and burn. */
  readonly stataTokenAddress: string;
  /** The EVM chain the vault operates on. */
  readonly evmChainId: bigint;
  /** CAIP-2 rendering of {@link VaultInitialiseConfig.evmChainId} (`eip155:<id>`), the MPC routing key. */
  readonly caip2Id: string;
  /**
   * The MPC response key for THIS vault contract (SEC1 hex): `f(MPC root key,
   * vault contract address, "midnight response key")`. The claim and
   * completeWithdraw circuits accept only responses ECDSA-signed by it.
   */
  readonly mpcResponseKey: string;
}

// A required environment value, with a message naming what produces it.
function requireValue(
  env: Record<string, string | undefined>,
  name: string,
  produces: string,
): string {
  const value = envOrUndefined(env, name);
  if (!value) throw new Error(`${name} is required to initialise the vault: ${produces}`);
  return value;
}

// Guard a value the caller may have pinned in the environment against the value
// derived here. A mismatch means the environment and the contract about to be
// initialised disagree, which would seal an address nothing can sign for.
function assertDerivedMatch(preset: string | undefined, derived: string, name: string): void {
  if (preset && preset.toLowerCase() !== derived.toLowerCase()) {
    throw new Error(
      `${name} is set to ${preset}, but the vault contract derives ${derived}. ` +
        "Unset it, or point it at the contract it belongs to.",
    );
  }
}

// Everything initialise needs that does NOT depend on the vault's own address,
// fully validated. Split out so a caller can fail on a missing or malformed
// value BEFORE deploying the contract those values would configure.
function resolveAddressFreeInputs(env: Record<string, string | undefined>): {
  mpcSecp256k1PublicKey: string;
  evmChainId: bigint;
  targets: VaultEvmTargets;
} {
  const mpcSecp256k1PublicKey = requireValue(
    env,
    "MPC_SECP256K1_PUBKEY",
    "it is the MPC network's public key, derived from MPC_ROOT_KEY by the setup pipeline",
  );
  const chainIdRaw = requireValue(
    env,
    "EVM_CHAIN_ID",
    "it pins the chain the vault's EVM transactions target",
  );
  if (!/^\d+$/.test(chainIdRaw) || chainIdRaw === "0") {
    throw new Error(`EVM_CHAIN_ID must be a positive integer; got "${chainIdRaw}".`);
  }

  // Parse the targets here rather than at the circuit call: a malformed
  // override must fail before anything is submitted, not mid-initialise.
  const targets = resolveEvmTargets(env);
  evmAddressBytes(targets.routerAddress);
  evmAddressBytes(targets.stataUnderlyingAddress);
  evmAddressBytes(targets.stataTokenAddress);

  return { mpcSecp256k1PublicKey, evmChainId: BigInt(chainIdRaw), targets };
}

/**
 * Resolve every `initialise` argument for the vault at `vaultContractAddress`.
 * The vault's EVM address and MPC response key are DERIVED from the MPC's
 * secp256k1 public key plus that contract address, so a fresh deploy needs no
 * new configuration; values already pinned in the environment are verified
 * against the derivation rather than trusted, since a stale pin would seal an
 * account the MPC never signs from.
 *
 * @param env - The environment providing `MPC_SECP256K1_PUBKEY`, `EVM_CHAIN_ID` and the
 *   optional `ROUTER` / `STATA_UNDERLYING` / `STATA_TOKEN` overrides.
 * @param vaultContractAddress - The deployed vault contract's address.
 * @returns The resolved arguments.
 * @throws {Error} If a required variable is missing, `EVM_CHAIN_ID` is not a positive
 *   integer, or a preset `EVM_VAULT_ADDRESS` / `MPC_RESPONSE_KEY` contradicts the derivation.
 */
export function resolveInitialiseConfig(
  env: Record<string, string | undefined>,
  vaultContractAddress: string,
): VaultInitialiseConfig {
  const { mpcSecp256k1PublicKey, evmChainId, targets } = resolveAddressFreeInputs(env);

  const vaultEvmAddress = deriveVaultEvmAddress(mpcSecp256k1PublicKey, vaultContractAddress);
  assertDerivedMatch(
    envOrUndefined(env, "EVM_VAULT_ADDRESS"),
    vaultEvmAddress,
    "EVM_VAULT_ADDRESS",
  );

  const mpcResponseKey = formatSecp256k1PublicKey(
    deriveMidnightResponseKey(mpcSecp256k1PublicKey, vaultContractAddress),
  );
  assertDerivedMatch(envOrUndefined(env, "MPC_RESPONSE_KEY"), mpcResponseKey, "MPC_RESPONSE_KEY");

  return {
    vaultEvmAddress,
    ...targets,
    evmChainId,
    caip2Id: `eip155:${String(evmChainId)}`,
    mpcResponseKey,
  };
}

/**
 * Fail now on anything `initialise` needs that does NOT depend on the vault's
 * address, so a deploy+initialise run cannot spend a full multistage deploy and
 * only then discover a missing chain id or a malformed router address, leaving
 * a deployed vault stranded uninitialised.
 *
 * @param env - The environment the subsequent {@link resolveInitialiseConfig} will read.
 * @throws {Error} If a required variable is missing or malformed.
 */
export function assertInitialiseInputsPresent(env: Record<string, string | undefined>): void {
  resolveAddressFreeInputs(env);
}

/**
 * Run the vault's one-shot `initialise` circuit, skipping when the ledger
 * already reports the vault initialised (so a rerun against a kept contract
 * address is a no-op rather than a circuit failure).
 *
 * The caller must hold the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param config - The resolved circuit arguments, from {@link resolveInitialiseConfig}.
 * @returns Whether this call initialised the vault or found it already initialised.
 * @throws {Error} If an argument is malformed or the circuit rejects the caller.
 */
export async function initialiseVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  config: VaultInitialiseConfig,
): Promise<InitialiseVaultOutcome> {
  if ((await readVaultLedger(publicDataProvider, vaultContractAddress)).initialised) {
    console.log("vault is already initialised, skipping initialise");
    return InitialiseVaultOutcome.AlreadyInitialised;
  }

  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`vault EVM address: ${config.vaultEvmAddress}`);
  console.log(`router:            ${config.routerAddress}`);
  console.log(`stata pair:        ${config.stataUnderlyingAddress} -> ${config.stataTokenAddress}`);
  console.log(`EVM chain:         ${String(config.evmChainId)} (${config.caip2Id})`);
  console.log(`MPC response key:  ${config.mpcResponseKey}`);

  const result = await vault.callTx.initialise(
    evmAddressBytes(config.vaultEvmAddress),
    evmAddressBytes(config.routerAddress),
    evmAddressBytes(config.stataUnderlyingAddress),
    evmAddressBytes(config.stataTokenAddress),
    config.evmChainId,
    asciiPadded(config.caip2Id, CAIP2_ID_BYTES),
    parseSecp256k1PublicKey(config.mpcResponseKey),
  );
  console.log(`initialise finalized in tx ${result.public.txId}`);
  return InitialiseVaultOutcome.Initialised;
}

/**
 * Join a deployed vault as the deployer and initialise it: the standalone
 * counterpart of {@link initialiseVaultContract} for entrypoints that hold no
 * session. The deployer identity resolves exactly as the deploy resolves it
 * (`VAULT_DEPLOYER_SECRET_KEY`, falling back to the `DEPLOYER_SEED` bytes), so
 * the caller and the commitment sealed at deploy agree by construction.
 *
 * @param env - The environment: the deploy SDK's Midnight node configuration, `DEPLOYER_SEED`,
 *   `VAULT_DEPLOYER_SECRET_KEY`, and everything {@link resolveInitialiseConfig} reads;
 *   defaults to `process.env`.
 * @param contractAddress - The vault to initialise; defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns Whether this call initialised the vault or found it already initialised.
 * @throws {Error} If no contract address is available, a required variable is missing,
 *   no contract answers at the address, or the circuit rejects the caller.
 */
export async function initialiseVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<InitialiseVaultOutcome> {
  // A blank explicit address is treated as absent, so a caller threading an
  // unset value through still gets the environment's answer (or its error).
  const explicitAddress = contractAddress?.trim();
  const vaultContractAddress =
    explicitAddress === undefined || explicitAddress === ""
      ? requireValue(
          env,
          "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
          "it names the vault to initialise (the deploy prints it)",
        )
      : explicitAddress;

  const deployConfig = getDeployConfig(env);
  const nodeConfig = deployConfig.midnightNodeConfig;
  setNetworkId(nodeConfig.networkId);

  // Resolve the arguments before starting a wallet: a missing variable or a
  // preset contradicting the derivation should fail here, not after a sync.
  const config = resolveInitialiseConfig(env, vaultContractAddress);

  const secretKey = parseIdentitySecretKey(
    "VAULT_DEPLOYER_SECRET_KEY",
    env,
    deployConfig.deployerSeed,
  );
  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, nodeConfig.networkId);

  return withSyncedWalletFacade(accountKeys, nodeConfig, async (facade) => {
    const providers = buildVaultProviders(facade, accountKeys, nodeConfig);
    const vault = await findDeployedContract(providers, {
      contractAddress: vaultContractAddress,
      compiledContract: vaultCompiledContract,
      privateStateId: VAULT_PRIVATE_STATE_ID,
      initialPrivateState: createVaultPrivateState(secretKey),
    });
    return initialiseVaultContract(
      vault,
      providers.publicDataProvider,
      vaultContractAddress,
      config,
    );
  });
}
