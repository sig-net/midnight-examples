// The vault's deploy flow: build, balance, prove and submit the split deploy
// transaction using the wallet and node-config plumbing of
// @sig-net/midnight-contract-deploy and the split-deploy builders of
// @sig-net/midnight-examples-lib. Everything contract-specific lives HERE: the constructor args (deployerCommitment, the
// signet contract reference), the witnesses, and the private state. Requires
// `yarn compile:zk` output (verifier keys) in the contract package's managed
// dir. The MPC response key is NOT a deploy input: it derives from the new
// contract's own address, so the deployer-gated initialise circuit pins it
// right after deploy (see {@link file://./initialise-vault.ts}).

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import * as ledger from "@midnightntwrk/ledger-v9";
import { contractAddressFromHex } from "@sig-net/midnight";
import {
  type AccountKeys,
  deriveAccountKeys,
  ensureFeeReady,
  envOrUndefined,
  getDeployConfig,
  getFaucetUrl,
  isLocalStandaloneNetwork,
  type MidnightNodeConfig,
  type NetworkId,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  withSyncedWalletFacade,
} from "@sig-net/midnight-contract-deploy";
import {
  createVaultPrivateState,
  expectedVk,
  pureCircuits,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  buildDeployTransactionDeferring,
  buildMaintenanceInsertTransaction,
  type DeferredCircuit,
  installedCircuitIds,
  SPLIT_DEPLOY_BASE_SUBMITTED_MARKER,
  SplitDeployAfterBaseSubmitError,
} from "@sig-net/midnight-examples-lib";

import { VAULT_MANAGED_PATH, vaultCompiledContract } from "./vault-contract-binding.ts";

// The full 17-circuit deploy overflows a block. Even the 9 core circuits overflow it (the
// post-burn keys are large), so the base registers just ONE small circuit and every other
// circuit is added by a maintenance update right after (each a tiny, fitting tx).
const BASE_DEPLOY_CIRCUITS: readonly string[] = ["approveRouter"];

const MINUTE_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the live contract state's serialized bytes and authority counter, or undefined if the
 * contract is not yet on the indexer.
 *
 * @param pdp - The indexer public-data provider.
 * @param contractAddress - The contract address to read.
 * @returns The serialized state and its maintenance-authority counter, or undefined.
 */
async function readContractState(
  pdp: IndexerPublicDataProvider,
  contractAddress: string,
): Promise<{ serialized: Uint8Array; counter: bigint } | undefined> {
  const state = await pdp.queryContractState(contractAddress);
  if (!state) return undefined;
  const serialized = state.serialize();
  const counter = ledger.ContractState.deserialize(serialized).maintenanceAuthority.counter;
  return { serialized, counter };
}

/**
 * The circuits to install before any other deferred one. `initialise` first:
 * a run that dies after that add leaves a contract `yarn initialise:erc20-vault`
 * can already initialise while the resume installs the rest.
 */
const FIRST_DEFERRED_CIRCUITS: readonly string[] = ["initialise"];

/**
 * The order the deferred circuits are installed in: {@link FIRST_DEFERRED_CIRCUITS}
 * first, in their listed order, then the rest in the order given.
 *
 * @param deferred - The circuits held back from the base deploy, in ledger order.
 * @returns The same circuits, reordered.
 */
export function orderDeferredCircuits(deferred: readonly DeferredCircuit[]): DeferredCircuit[] {
  const first = FIRST_DEFERRED_CIRCUITS.flatMap((id) =>
    deferred.filter((circuit) => circuit.circuitId === id),
  );
  return [
    ...first,
    ...deferred.filter((circuit) => !FIRST_DEFERRED_CIRCUITS.includes(circuit.circuitId)),
  ];
}

/**
 * Install the circuits deferred from the base deploy via one maintenance update each, in
 * {@link orderDeferredCircuits} order, waiting for the authority counter to advance between them
 * so every update binds to the current counter. Each update re-syncs the wallet (fresh fee coins)
 * and is signed by the `MAINTENANCE_SIGNING_KEY` authority sealed at deploy time.
 *
 * @param nodeConfig - The Midnight stack config (node/indexer endpoints + network id).
 * @param env - The environment carrying the `MAINTENANCE_SIGNING_KEY` that signs each update.
 * @param accountKeys - The deployer's derived account keys (pays the update fees).
 * @param networkId - The network the updates target.
 * @param contractAddress - The deployed base contract's address.
 * @param deferred - The circuits to add.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor DUST before an add.
 * @throws {Error} If the base deploy never indexes, no spendable DUST appears after registering
 *   the wallet's NIGHT, or an add's counter never advances.
 */
async function addDeferredCircuits(
  nodeConfig: MidnightNodeConfig,
  env: Record<string, string | undefined>,
  accountKeys: AccountKeys,
  networkId: NetworkId,
  contractAddress: string,
  deferred: readonly DeferredCircuit[],
): Promise<void> {
  if (deferred.length === 0) return;
  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });
  try {
    await addDeferredCircuitsThrough(
      pdp,
      nodeConfig,
      env,
      accountKeys,
      networkId,
      contractAddress,
      deferred,
    );
  } finally {
    // The provider holds a WebSocket that would otherwise keep the entrypoint alive.
    await pdp.dispose();
  }
}

// The body of {@link addDeferredCircuits}, against a provider the caller disposes.
async function addDeferredCircuitsThrough(
  pdp: IndexerPublicDataProvider,
  nodeConfig: MidnightNodeConfig,
  env: Record<string, string | undefined>,
  accountKeys: AccountKeys,
  networkId: NetworkId,
  contractAddress: string,
  deferred: readonly DeferredCircuit[],
): Promise<void> {
  // Wait for the base deploy to be indexed before the first maintenance query.
  const indexDeadline = Date.now() + 5 * MINUTE_MS;
  while (!(await readContractState(pdp, contractAddress))) {
    if (Date.now() > indexDeadline) {
      throw new Error(`base deploy ${contractAddress} was not indexed within 5 minutes`);
    }
    await sleep(3000);
  }

  for (const { circuitId, verifierKey } of orderDeferredCircuits(deferred)) {
    const current = await readContractState(pdp, contractAddress);
    if (!current) throw new Error(`contract state for ${contractAddress} vanished mid-deploy`);
    console.log(`[${circuitId}] maintenance-add at counter ${current.counter.toString()}`);

    const { serializedTransaction } = buildMaintenanceInsertTransaction(
      networkId,
      env,
      contractAddress,
      circuitId,
      verifierKey,
      current.serialized,
    );
    const txId = await withSyncedWalletFacade(accountKeys, nodeConfig, async (facade, state) => {
      await ensureFeeReady(facade, accountKeys, state, networkId, getFaucetUrl(env, networkId));
      return submitUnprovenTransaction(facade, accountKeys, serializedTransaction);
    });
    const target = current.counter + 1n;
    console.log(`[${circuitId}] maintenance tx ${txId}, waiting for counter ${target.toString()}`);

    const deadline = Date.now() + 5 * MINUTE_MS;
    for (;;) {
      await sleep(5000);
      const now = await readContractState(pdp, contractAddress);
      if (now && now.counter >= target) {
        console.log(`[${circuitId}] confirmed at counter ${now.counter.toString()}`);
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`[${circuitId}] timed out waiting for counter ${target.toString()}`);
      }
    }
  }
}

/**
 * Resolve the environment the deploy signs its maintenance updates with. The split deploy adds the
 * deferred circuits via maintenance updates, so the contract needs a maintenance authority: on a
 * deployed network `MAINTENANCE_SIGNING_KEY` is REQUIRED, since it is the only way to add or
 * replace a circuit afterwards and an ephemeral one would leave the contract unmaintainable
 * forever. The local standalone chain is throwaway, so an ephemeral key is generated into a COPY
 * of `env` (never `process.env`, and never the caller's map): the deploy and its adds all run
 * inside this one call, so it need not outlive them.
 *
 * @param env - The caller's environment.
 * @param networkId - The network the deploy targets.
 * @returns `env` itself, or a copy carrying a generated ephemeral key.
 * @throws {Error} If a deployed network has no `MAINTENANCE_SIGNING_KEY`.
 */
function resolveMaintenanceEnv(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): Record<string, string | undefined> {
  if (envOrUndefined(env, "MAINTENANCE_SIGNING_KEY")) return env;
  if (!isLocalStandaloneNetwork(networkId)) {
    throw new Error(
      `MAINTENANCE_SIGNING_KEY is required on "${networkId}". The split deploy installs most ` +
        "circuits via maintenance updates, and the key signing them becomes the contract's sealed " +
        "maintenance authority, the only way to add or replace a circuit later. Set it to 32 " +
        "bytes of hex (0x optional) and KEEP it.",
    );
  }
  console.log("generated an ephemeral MAINTENANCE_SIGNING_KEY for the local split deploy");
  return { ...env, MAINTENANCE_SIGNING_KEY: randomBytes(32).toString("hex") };
}

/** The outcome of a successful vault deployment. */
export interface VaultDeployment {
  /** Address of the deployed vault contract on Midnight. */
  readonly contractAddress: string;
  /** Identifier of the submitted base deploy transaction. */
  readonly txId: TransactionIdentifier;
}

/**
 * Deploy the vault contract: read config from `env`, derive the deployer
 * identity, build/prove the base deploy transaction, submit it through a synced
 * wallet, then install every deferred circuit by a maintenance update. Progress
 * is logged to the console.
 *
 * The deployer identity comes from `VAULT_DEPLOYER_SECRET_KEY` (falling back
 * to the `DEPLOYER_SEED` bytes): its commitment is sealed into the contract
 * as `deployer`, and the same secret must later answer the `callerSecretKey`
 * witness to pass `initialise`'s gate. That gate is what protects the
 * post-deploy configuration (vault EVM address, chain, MPC response key)
 * from front-running (see {@link file://./initialise-vault.ts}).
 *
 * @param env - Environment providing `DEPLOYER_SEED`, `VAULT_DEPLOYER_SECRET_KEY`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the signet contract to seal as the
 *   cross-contract signer), `MAINTENANCE_SIGNING_KEY` and the deploy SDK's Midnight
 *   node configuration; defaults to `process.env`.
 * @returns The deployed contract address and base deploy transaction id.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed,
 *   `MAINTENANCE_SIGNING_KEY` is missing on a deployed network, no spendable
 *   DUST appears after registering the wallet's NIGHT, or the base deploy
 *   submission fails.
 * @throws {SplitDeployAfterBaseSubmitError} If installing the deferred
 *   circuits fails after the base deploy was submitted: a rerun would deploy
 *   a second contract, so callers must not retry on it.
 */
export async function deployVault(
  env: Record<string, string | undefined> = process.env,
): Promise<VaultDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const deployEnv = resolveMaintenanceEnv(env, networkId);

  const secretKey = parseIdentitySecretKey(
    "VAULT_DEPLOYER_SECRET_KEY",
    env,
    deployConfig.deployerSeed,
  );
  const deployerCommitment = pureCircuits.userCommitment(secretKey);

  // The signet contract the vault cross-contract-calls to register signature
  // request notifications, sealed into the vault as the SignetSigner
  // reference, so it must be deployed first.
  const signetContractAddress = envOrUndefined(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  if (!signetContractAddress) {
    throw new Error(
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)",
    );
  }
  const signetSigner = contractAddressFromHex(signetContractAddress);

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying erc20-vault to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const deployTransaction = await buildDeployTransactionDeferring(
    vaultCompiledContract,
    networkId,
    accountKeys.shieldedSecretKeys.coinPublicKey,
    deployEnv,
    createVaultPrivateState(secretKey),
    BASE_DEPLOY_CIRCUITS,
    deployerCommitment,
    signetSigner,
  );
  const { contractAddress, deferred } = deployTransaction;
  console.log(`contract address (pre-submit): ${contractAddress}`);
  console.log(
    `base deploy registers ${String(BASE_DEPLOY_CIRCUITS.length)} circuit(s); ` +
      `deferring ${String(deferred.length)} for maintenance adds`,
  );

  const txId = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      await ensureFeeReady(facade, accountKeys, state, networkId, getFaucetUrl(env, networkId));
      return submitUnprovenTransaction(
        facade,
        accountKeys,
        deployTransaction.serializedTransaction,
      );
    },
  );
  // First line printed once submission returns: a driver watching this
  // entrypoint's output stops retrying here, and the maintenance adds below
  // are what it must not restart from the top.
  console.log(SPLIT_DEPLOY_BASE_SUBMITTED_MARKER);
  console.log(`submitted base deploy tx ${txId}`);
  console.log(`deployed erc20-vault base at ${contractAddress}`);

  try {
    await addDeferredCircuits(
      deployConfig.midnightNodeConfig,
      deployEnv,
      accountKeys,
      networkId,
      contractAddress,
      deferred,
    );
  } catch (error) {
    throw new SplitDeployAfterBaseSubmitError(
      `installing the deferred circuits on ${contractAddress} failed after its base deploy ` +
        "was submitted",
      { cause: error },
    );
  }
  console.log(
    `deployed erc20-vault at ${contractAddress} ` +
      `(all ${String(deferred.length + BASE_DEPLOY_CIRCUITS.length)} circuits installed)`,
  );

  return { contractAddress, txId };
}

/** The outcome of {@link resumeVaultDeploy}. */
export interface ResumedVaultDeploy {
  /** Address of the vault the resume ran against. */
  readonly contractAddress: string;
  /** The circuit ids this call installed, in the order they were added. */
  readonly installed: readonly string[];
}

/**
 * The deferred-circuit records for `circuitIds`, read from the contract package's compiled
 * verifier keys, each checked against the generated module's `expectedVk` digest so a checkout
 * whose keys differ from its module cannot install a key the module's proofs will not verify
 * against.
 *
 * @param circuitIds - The circuits to read keys for.
 * @returns One record per circuit, in the given order.
 * @throws {Error} If a key file is missing (run `yarn compile:erc20-vault:zk`) or its digest is not
 *   the module's expected one.
 */
export function readDeferredCircuits(circuitIds: readonly string[]): DeferredCircuit[] {
  return circuitIds.map((circuitId) => {
    const path = join(VAULT_MANAGED_PATH, "keys", `${circuitId}.verifier`);
    let verifierKey: Uint8Array;
    try {
      verifierKey = new Uint8Array(readFileSync(path));
    } catch (error) {
      throw new Error(
        `no verifier key for ${circuitId} at ${path}: run \`yarn compile:erc20-vault:zk\``,
        {
          cause: error,
        },
      );
    }
    const digest = createHash("sha256").update(verifierKey).digest("hex");
    const expected = expectedVk[circuitId];
    if (digest !== expected) {
      throw new Error(
        `verifier key ${path} has digest ${digest}, but the generated module expects ${String(expected)}: ` +
          "the keys and the module come from different compiles",
      );
    }
    return { circuitId, verifierKey };
  });
}

/**
 * Finish a split deploy that died after its base deploy landed: read the live contract, install
 * every provable circuit it lacks by a maintenance update each (same order, same authority and
 * same fee wallet as {@link deployVault}), and leave the contract ready for
 * `yarn initialise:erc20-vault`. Idempotent: a contract with every circuit installed is a no-op.
 * The verifier keys come from the checkout's compiled output, checked against the generated
 * module, so the checkout must be the one the contract was deployed from (same tag, `compile:zk`
 * run).
 *
 * @param env - Environment providing `DEPLOYER_SEED`, `MAINTENANCE_SIGNING_KEY` (the authority
 *   sealed at deploy, without which a resume cannot work) and the deploy SDK's Midnight node
 *   configuration. Defaults to `process.env`.
 * @param contractAddress - The vault to resume. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns The address and the circuits this call installed.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor DUST before an add.
 * @throws {Error} If no address is available, `MAINTENANCE_SIGNING_KEY` is unset, no contract
 *   answers at the address, a verifier key is missing or mismatched, or an add fails.
 */
export async function resumeVaultDeploy(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<ResumedVaultDeploy> {
  const explicitAddress = contractAddress?.trim();
  const vaultContractAddress =
    explicitAddress === undefined || explicitAddress === ""
      ? envOrUndefined(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS")
      : explicitAddress;
  if (!vaultContractAddress) {
    throw new Error(
      "MIDNIGHT_VAULT_CONTRACT_ADDRESS is required to resume a deploy: the interrupted run printed " +
        `it after "${SPLIT_DEPLOY_BASE_SUBMITTED_MARKER}"`,
    );
  }
  if (!envOrUndefined(env, "MAINTENANCE_SIGNING_KEY")) {
    throw new Error(
      "MAINTENANCE_SIGNING_KEY is required to resume a deploy: the maintenance adds must be signed " +
        "by the authority sealed at the base deploy.",
    );
  }

  const deployConfig = getDeployConfig(env);
  const nodeConfig = deployConfig.midnightNodeConfig;
  const { networkId } = nodeConfig;
  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });
  let installed: string[];
  try {
    const live = await readContractState(pdp, vaultContractAddress);
    if (!live) {
      throw new Error(
        `no contract at ${vaultContractAddress} on ${networkId} (${nodeConfig.indexerUrl})`,
      );
    }
    installed = installedCircuitIds(live.serialized);
  } finally {
    await pdp.dispose();
  }

  const missing = Object.keys(expectedVk).filter((circuitId) => !installed.includes(circuitId));
  console.log(
    `resuming erc20-vault ${vaultContractAddress} on ${networkId}: ` +
      `${String(installed.length)} circuit(s) installed, ${String(missing.length)} missing` +
      (missing.length > 0 ? ` (${missing.join(", ")})` : ""),
  );
  if (missing.length === 0) {
    return { contractAddress: vaultContractAddress, installed: [] };
  }

  const deferred = orderDeferredCircuits(readDeferredCircuits(missing));
  await addDeferredCircuits(
    nodeConfig,
    env,
    accountKeys,
    networkId,
    vaultContractAddress,
    deferred,
  );
  console.log(
    `resumed erc20-vault at ${vaultContractAddress} ` +
      `(all ${String(Object.keys(expectedVk).length)} circuits installed)`,
  );
  return { contractAddress: vaultContractAddress, installed: deferred.map((c) => c.circuitId) };
}
