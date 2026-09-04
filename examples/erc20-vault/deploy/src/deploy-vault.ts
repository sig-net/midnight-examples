// The vault's deploy flow: build, balance, prove and submit the split deploy
// transaction using the generic plumbing in @sig-net/midnight-examples-lib. Everything
// contract-specific lives HERE: the constructor args (deployerCommitment, the
// signet contract reference), the witnesses, and the private state. Requires
// `yarn compile:zk` output (verifier keys) in the contract package's managed
// dir. The MPC response key is NOT a deploy input: it derives from the new
// contract's own address, so the deployer-gated initialise circuit pins it
// right after deploy (see {@link file://./initialise-vault.ts}).

import { randomBytes } from "node:crypto";

import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import * as ledger from "@midnightntwrk/ledger-v9";
import { hexToBytes } from "@sig-net/midnight";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-client";
import {
  createVaultPrivateState,
  pureCircuits,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  type AccountKeys,
  assertDeployerFunded,
  buildDeployTransactionDeferring,
  buildMaintenanceInsertTransaction,
  type DeferredCircuit,
  deriveAccountKeys,
  envOrUndefined,
  getDeployConfig,
  isLocalStandaloneNetwork,
  type MidnightNodeConfig,
  type NetworkId,
  parseIdentitySecret,
  SPLIT_DEPLOY_BASE_SUBMITTED_MARKER,
  SplitDeployAfterBaseSubmitError,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  withSyncedWalletFacade,
} from "@sig-net/midnight-examples-lib";

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
 * Install the circuits deferred from the base deploy via one maintenance update each, waiting for
 * the authority counter to advance between them so every update binds to the current counter. Each
 * update re-syncs the wallet (fresh fee coins) and is signed by the `MIDNIGHT_MAINTENANCE_PRIVATE_KEY`
 * authority sealed at deploy time.
 *
 * @param nodeConfig - The Midnight stack config (node/indexer endpoints + network id).
 * @param env - The environment carrying the `MIDNIGHT_MAINTENANCE_PRIVATE_KEY` that signs each update.
 * @param accountKeys - The deployer's derived account keys (pays the update fees).
 * @param networkId - The network the updates target.
 * @param contractAddress - The deployed base contract's address.
 * @param deferred - The circuits to add, in order.
 * @throws {Error} If the base deploy never indexes, or an add's counter never advances.
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

  // Wait for the base deploy to be indexed before the first maintenance query.
  const indexDeadline = Date.now() + 5 * MINUTE_MS;
  while (!(await readContractState(pdp, contractAddress))) {
    if (Date.now() > indexDeadline) {
      throw new Error(`base deploy ${contractAddress} was not indexed within 5 minutes`);
    }
    await sleep(3000);
  }

  for (const { circuitId, verifierKey } of deferred) {
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
      assertDeployerFunded(state);
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
 * Convert a contract address (hex, optional `0x`) into the reference shape a
 * Compact contract-typed constructor arg expects: `{ bytes: Uint8Array(32) }`.
 *
 * @param contractAddress - The 32-byte contract address in hex.
 * @returns The `{ bytes }` reference.
 * @throws {Error} If the address is not 32 bytes of hex.
 */
function contractAddressToReference(contractAddress: string): { bytes: Uint8Array } {
  const hex = contractAddress.startsWith("0x") ? contractAddress.slice(2) : contractAddress;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`not a 32-byte contract address in hex: "${contractAddress}"`);
  }
  return { bytes: hexToBytes(hex) };
}

/**
 * Resolve the environment the deploy signs its maintenance updates with. The split deploy adds the
 * deferred circuits via maintenance updates, so the contract needs a maintenance authority: on a
 * deployed network `MIDNIGHT_MAINTENANCE_PRIVATE_KEY` is REQUIRED, since it is the only way to add or
 * replace a circuit afterwards and an ephemeral one would leave the contract unmaintainable
 * forever. The local standalone chain is throwaway, so an ephemeral key is generated into a COPY
 * of `env` (never `process.env`, and never the caller's map): the deploy and its adds all run
 * inside this one call, so it need not outlive them.
 *
 * @param env - The caller's environment.
 * @param networkId - The network the deploy targets.
 * @returns `env` itself, or a copy carrying a generated ephemeral key.
 * @throws {Error} If a deployed network has no `MIDNIGHT_MAINTENANCE_PRIVATE_KEY`.
 */
function resolveMaintenanceEnv(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): Record<string, string | undefined> {
  if (envOrUndefined(env, "MIDNIGHT_MAINTENANCE_PRIVATE_KEY")) return env;
  if (!isLocalStandaloneNetwork(networkId)) {
    throw new Error(
      `MIDNIGHT_MAINTENANCE_PRIVATE_KEY is required on "${networkId}". The split deploy installs most ` +
        "circuits via maintenance updates, and the key signing them becomes the contract's sealed " +
        "maintenance authority, the only way to add or replace a circuit later. Set it to 32 " +
        "bytes of hex (0x optional) and KEEP it.",
    );
  }
  console.log("generated an ephemeral MIDNIGHT_MAINTENANCE_PRIVATE_KEY for the local split deploy");
  return { ...env, MIDNIGHT_MAINTENANCE_PRIVATE_KEY: randomBytes(32).toString("hex") };
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
 * The deployer identity comes from `VAULT_DEPLOYER_SECRET` (falling back
 * to the `MIDNIGHT_DEPLOYER_WALLET_SEED` bytes): its commitment is sealed into the contract
 * as `deployer`, and the same secret must later answer the `callerSecretKey`
 * witness to pass `initialise`'s gate. That gate is what protects the
 * post-deploy configuration (vault EVM address, chain, MPC response key)
 * from front-running (see {@link file://./initialise-vault.ts}).
 *
 * @param env - Environment providing `MIDNIGHT_DEPLOYER_WALLET_SEED`, `VAULT_DEPLOYER_SECRET`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the signet contract to seal as the
 *   cross-contract signer), `MIDNIGHT_MAINTENANCE_PRIVATE_KEY` and lib's Midnight node
 *   configuration; defaults to `process.env`.
 * @returns The deployed contract address and base deploy transaction id.
 * @throws {Error} If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed,
 *   `MIDNIGHT_MAINTENANCE_PRIVATE_KEY` is missing on a deployed network, the deployer
 *   wallet holds no funds, or the base deploy submission fails.
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

  const secretKey = parseIdentitySecret("VAULT_DEPLOYER_SECRET", env, deployConfig.deployerSeed);
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
  const signetSigner = contractAddressToReference(signetContractAddress);

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
      assertDeployerFunded(state);
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
