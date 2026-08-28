// Deploy entrypoint (`yarn deploy`): builds, balances, proves and submits the
// vault's deploy transaction using the generic plumbing in
// @midnight-examples/lib. Everything contract-specific lives HERE: the
// constructor args (deployerCommitment, the signet contract reference), the
// witnesses, and the private state. Requires `yarn compile:zk` output
// (verifier keys) in src/managed. The MPC response key is NOT a deploy input:
// it derives from the new contract's own address, so the deployer-gated
// initialize circuit pins it right after deploy (see the initialize flow).
//
// This file sits OUTSIDE src/ deliberately: it is a Node entrypoint (env
// access, lib imports), while everything under src/ stays environment-agnostic.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransactionDeferring,
  buildMaintenanceInsertTransaction,
  type DeferredCircuit,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  type MidnightNodeConfig,
  type NetworkId,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  withSyncedWalletFacade,
} from "@midnight-examples/lib";
import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import * as ledger from "@midnightntwrk/ledger-v9";
import { hexToBytes } from "@sig-net/midnight";

import { Contract, pureCircuits } from "./src/managed/erc20-vault/contract/index.js";
import { createVaultPrivateState, type VaultPrivateState, witnesses } from "./src/witnesses.ts";

// The full 14-circuit deploy overflows a block. Even the 9 core circuits overflow it (the
// post-burn keys are large), so the base registers just ONE small circuit and every other
// circuit is added by a maintenance update right after (each a tiny, fitting tx).
const BASE_DEPLOY_CIRCUITS = ["approveRouter"] as const;

const MINUTE_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type AccountKeys = ReturnType<typeof deriveAccountKeys>;

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
 * update re-syncs the wallet (fresh fee coins) and is signed by the retained MAINTENANCE_SIGNING_KEY.
 *
 * @param nodeConfig - The Midnight stack config (node/indexer endpoints + network id).
 * @param accountKeys - The deployer's derived account keys (pays the update fees).
 * @param networkId - The network the updates target.
 * @param contractAddress - The deployed base contract's address.
 * @param deferred - The circuits to add, in order.
 * @throws {Error} If the base deploy never indexes, or an add's counter never advances.
 */
async function addDeferredCircuits(
  nodeConfig: MidnightNodeConfig,
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
    console.log(`[${circuitId}] maintenance tx ${txId} — waiting for counter ${target.toString()}`);

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

/** The outcome of a successful vault deployment. */
interface VaultDeployment {
  /** Address of the deployed vault contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * Deploy the vault contract: read config from `env`, derive the deployer
 * identity, build/prove the deploy transaction and submit it through a synced
 * wallet. Progress is logged to the console.
 *
 * The deployer identity comes from `VAULT_DEPLOYER_SECRET_KEY` (falling back
 * to the `DEPLOYER_SEED` bytes): its commitment is sealed into the contract
 * as `deployer`, and the same secret must later answer the `callerSecretKey`
 * witness to pass `initialize`'s gate. That gate is what protects the
 * post-deploy configuration (vault EVM address, chain, MPC response key)
 * from front-running.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `VAULT_DEPLOYER_SECRET_KEY`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the
 *   signet contract to seal as the cross-contract signer) and lib's Midnight
 *   node configuration.
 * @returns The deployed contract address and deploy transaction id.
 * @throws {Error} If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed, the
 *   deployer wallet holds no funds, or submission fails.
 */
async function deployVault(
  env: Record<string, string | undefined> = process.env,
): Promise<VaultDeployment> {
  // The split deploy adds the deferred circuits via maintenance updates, which need a maintenance
  // authority to sign. Generate an ephemeral one when unset (the deploy and the adds run in this
  // one process, so it need not persist). A real deploy sets MAINTENANCE_SIGNING_KEY to keep the
  // contract maintainable afterwards; the deploy uses whatever is set as the sealed authority.
  if (!process.env.MAINTENANCE_SIGNING_KEY?.trim()) {
    process.env.MAINTENANCE_SIGNING_KEY = randomBytes(32).toString("hex");
    console.log("generated an ephemeral MAINTENANCE_SIGNING_KEY for the split deploy");
  }

  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const secretKey = parseIdentitySecretKey(
    "VAULT_DEPLOYER_SECRET_KEY",
    env,
    deployConfig.deployerSeed,
  );
  const deployerCommitment = pureCircuits.userCommitment(secretKey);

  // The signet contract the vault cross-contract-calls to register signature
  // request notifications, sealed into the vault as the SignetSigner
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error(
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)",
    );
  }
  const signetSigner = contractAddressToReference(signetContractAddress);

  const compiledContract = makeCompiledContract<Contract<VaultPrivateState>, VaultPrivateState>(
    "erc20-vault",
    Contract,
    witnesses,
    fileURLToPath(new URL("./src/managed/erc20-vault", import.meta.url)),
  );

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying erc20-vault to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  // The full 14-circuit deploy overflows a block, so register one small circuit in the base deploy
  // and add every other circuit via maintenance updates (needs MAINTENANCE_SIGNING_KEY).
  const deployTransaction = await buildDeployTransactionDeferring(
    compiledContract,
    networkId,
    accountKeys.shieldedSecretKeys.coinPublicKey,
    createVaultPrivateState(secretKey),
    BASE_DEPLOY_CIRCUITS as unknown as string[],
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
  console.log(`submitted base deploy tx ${txId}`);
  console.log(`deployed erc20-vault base at ${contractAddress}`);

  await addDeferredCircuits(
    deployConfig.midnightNodeConfig,
    accountKeys,
    networkId,
    contractAddress,
    deferred,
  );
  console.log(
    `deployed erc20-vault at ${contractAddress} ` +
      `(all ${String(deferred.length + BASE_DEPLOY_CIRCUITS.length)} circuits installed)`,
  );

  return { contractAddress, txId };
}

await deployVault();
