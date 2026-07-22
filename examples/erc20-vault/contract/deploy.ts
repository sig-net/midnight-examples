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

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@midnight-examples/lib";
import { hexToBytes } from "@sig-net/midnight";

import { Contract, pureCircuits } from "./src/managed/erc20-vault/contract/index.js";
import { createVaultPrivateState, witnesses, type VaultPrivateState } from "./src/witnesses.ts";

/**
 * Convert a contract address (hex, optional `0x`) into the reference shape a
 * Compact contract-typed constructor arg expects: `{ bytes: Uint8Array(32) }`.
 *
 * @param contractAddress - The 32-byte contract address in hex.
 * @returns The `{ bytes }` reference.
 * @throws If the address is not 32 bytes of hex.
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
 * @throws If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed, the
 *   deployer wallet holds no funds, or submission fails.
 */
async function deployVault(env: Record<string, string | undefined> = process.env): Promise<VaultDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", env, deployConfig.deployerSeed);
  const deployerCommitment = pureCircuits.userCommitment(secretKey);

  // The signet contract the vault cross-contract-calls to register signature
  // request notifications, sealed into the vault as the SignetSigner
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error("MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)");
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

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);

      const deployTransaction = await buildDeployTransaction(
        compiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createVaultPrivateState(secretKey),
        deployerCommitment,
        signetSigner,
      );
      console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

      const submittedTxId = await submitUnprovenTransaction(
        facade,
        accountKeys,
        deployTransaction.serializedTransaction,
      );
      return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
    },
  );

  console.log(`submitted deploy tx ${txId}`);
  console.log(`deployed erc20-vault at ${contractAddress}`);

  return { contractAddress, txId };
}

await deployVault();
