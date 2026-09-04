// The example's vitest globalSetup: compose the ordered setup pipeline
// (environment check -> wallet seeds + root funding -> EVM chain + test token
// -> MPC key derivation -> signet deploy -> fakenet responder hand-off ->
// vault zk compile + deploy -> MPC response key -> derived EVM addresses ->
// fork dealing -> fork dependency check -> MPC hand-off printout) from the
// harness's generic steps plus the vault-specific steps below, and run it via
// `runSetupPipeline` in vitest's main process. The signet contract needs no zk-compile step: its
// proving keys ship inside the published @sig-net/midnight-contract package
// the deploy reads them from. The MPC response key step runs AFTER the vault
// deploy: the key derives from the vault's own contract address, and the
// initialise flow pins it on-chain.

import { deriveEvmAddress } from "@sig-net/midnight";
import {
  deriveVaultEvmAddress,
  STATA_USDC,
  UNISWAP_SWAP_ROUTER_02,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { deployVault } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { SplitDeployAfterBaseSubmitError } from "@sig-net/midnight-examples-lib";
import {
  assertEnvironment,
  compileContractZk,
  deploySignetContractStep,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureWalletSeeds,
  ensureWalletsFunded,
  logSkip,
  NonRetryableError,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  requireEnv,
  resolveEvmChain,
  retryWhileDustGenerates,
  runSetupPipeline,
  type SetupStep,
  startFakenetResponder,
} from "@sig-net/midnight-examples-test-harness";
import type { TestProject } from "vitest/node";

import { stataAvailable } from "./evm-stata.ts";
import { uniswapAvailable } from "./evm-swap.ts";
import { dealForkEvmAccounts, SEPOLIA_USDC } from "./fork-funding.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

// The env keys the setup steps populate, in derivation order — the "Minimal
// .env block" printout reads like the flow that produced it.
const PIPELINE_KEYS = [
  "EVM_CHAIN_ID",
  "EVM_ERC20_CONTRACT_ADDRESS",
  "MPC_ROOT_PRIVATE_KEY",
  "MPC_ROOT_PUBLIC_KEY",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MPC_VAULT_RESPONSE_PUBLIC_KEY",
  "EVM_VAULT_ACCOUNT_ADDRESS",
  "EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS",
] as const;

/**
 * Deploy the vault contract by calling the deploy package's `deployVault`
 * in-process: the same function the `deploy` and `deploy-initialise`
 * entrypoints run, so the split deploy (base deploy plus one maintenance
 * update per deferred circuit) this suite exercises is the one a remote
 * bring-up performs. Skips when `MIDNIGHT_VAULT_CONTRACT_ADDRESS` is already
 * set. Retries while the deployer wallet's dust is still generating on a
 * young chain, but ONLY while the base deploy has not been submitted: the
 * split deploy has no resume path, so a rerun past that point would deploy a
 * SECOND contract and orphan the half-installed first one.
 *
 * @param env - The suite's env accumulator (the deploy reads `MIDNIGHT_DEPLOYER_WALLET_SEED`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`, `MIDNIGHT_MAINTENANCE_PRIVATE_KEY` and node
 *   config from it).
 * @throws {NonRetryableError} If the deploy failed after its base deploy was submitted.
 * @throws {Error} If the deploy fails otherwise, after the dust-generation retries.
 */
async function deployVaultContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip(
      "deploy vault contract",
      `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`,
    );
    return;
  }
  // The deploy seals the DEPLOYER identity commitment, defaulting to the
  // deployer wallet seed's bytes, and `initialise` is deployer-gated. The
  // suites therefore drive initialise from a deployer session, exactly as the
  // deploy package's own entrypoint does, so the local run exercises the same
  // gate a remote bring-up meets.
  const { contractAddress } = await retryWhileDustGenerates("deploy vault contract", async () => {
    try {
      return await deployVault(env);
    } catch (error) {
      // Past base submission a rerun costs a second contract. Everything else
      // stays retryable and keeps its original error.
      if (error instanceof SplitDeployAfterBaseSubmitError) {
        throw new NonRetryableError(
          "vault deploy failed after its base deploy was submitted, not retrying: " +
            "a retry would deploy a second contract and orphan the first",
          { cause: error },
        );
      }
      throw error;
    }
  });
  env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
  console.log(
    ` ➜ 💡 Set as MIDNIGHT_VAULT_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`,
  );
}

/**
 * Ensure `EVM_VAULT_ACCOUNT_ADDRESS` matches the vault's derived EVM account, deriving
 * it when absent. The derivation is the contract package's
 * {@link deriveVaultEvmAddress}, the same one the deploy package's
 * `resolveInitialiseConfig` seals on-chain, so this step and the initialise
 * agree by construction.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_VAULT_ACCOUNT_ADDRESS` mismatches the derivation.
 */
function ensureVaultEvmAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveVaultEvmAddress(
    requireEnv(env, "MPC_ROOT_PUBLIC_KEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
  );
  if (env.EVM_VAULT_ACCOUNT_ADDRESS) {
    console.log(
      `Found EVM_VAULT_ACCOUNT_ADDRESS in the environment as ${env.EVM_VAULT_ACCOUNT_ADDRESS}`,
    );
    // Case-insensitive: an EVM address is EIP-55 checksummed, so the same
    // account differs only in case between one speller and another.
    if (env.EVM_VAULT_ACCOUNT_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `EVM_VAULT_ACCOUNT_ADDRESS should be derived from MPC_ROOT_PUBLIC_KEY + vault contract address: expected ${expectedAddress}, found ${env.EVM_VAULT_ACCOUNT_ADDRESS}`,
      );
    }
    logSkip("check/derive vault EVM address", `EVM_VAULT_ACCOUNT_ADDRESS is set correctly`);
    return;
  }
  env.EVM_VAULT_ACCOUNT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_VAULT_ACCOUNT_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the vault's own EVM account (path "vault")`);
  console.log(
    ` ➜ fund it with ETH for gas before running withdrawals (automatic on the local dev chain)`,
  );
  console.log(
    ` ➜ 💡 Set as EVM_VAULT_ACCOUNT_ADDRESS in the environment to skip this step on the next run`,
  );
}

/**
 * Ensure `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS` matches the user's derived EVM account
 * (`MPC_ROOT_PUBLIC_KEY` + vault contract address, path = the hex rendering
 * of the user's identity commitment), deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS` mismatches the derivation.
 */
function ensureUserEvmAddress(env: NodeJS.ProcessEnv): void {
  const identity = resolveUserIdentity(env);
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_ROOT_PUBLIC_KEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    identity.commitmentHex,
  );
  if (env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS) {
    console.log(
      `Found EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS in the environment as ${env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS}`,
    );
    if (env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS should be derived from MPC_ROOT_PUBLIC_KEY + vault contract + user identity: expected ${expectedAddress}, found ${env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS}`,
      );
    }
    logSkip("check/derive user EVM address", `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS is set correctly`);
    return;
  }
  env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the user's derived EVM account (path = identity commitment)`);
  console.log(
    ` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit) — automatic on the local dev chain`,
  );
  console.log(
    ` ➜ 💡 Set as EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS in the environment to skip this step on the next run`,
  );
}

/**
 * Default `EVM_RPC_URL` to the local docker compose `evm` service when unset
 * — the same local-stack defaulting lib gives the Midnight endpoints, so a
 * fresh clone runs green with an empty environment. Any real chain must be
 * set explicitly.
 *
 * @param env - The suite's env accumulator.
 */
function defaultEvmRpcUrl(env: NodeJS.ProcessEnv): void {
  if (!env.EVM_RPC_URL) {
    env.EVM_RPC_URL = "http://127.0.0.1:8545";
    console.log(`defaulted EVM_RPC_URL=${env.EVM_RPC_URL} (the local docker compose evm service)`);
  }
}

/**
 * Default `EVM_ERC20_CONTRACT_ADDRESS` to real Sepolia USDC — the suites run against a Sepolia fork, so the
 * token is the real (unmintable) USDC rather than a locally deployed test token. Any other
 * ERC20 with a standard balance mapping (dealable by storage write) can be pinned explicitly.
 *
 * @param env - The suite's env accumulator.
 */
function ensureErc20Address(env: NodeJS.ProcessEnv): void {
  if (env.EVM_ERC20_CONTRACT_ADDRESS) {
    logSkip(
      "default EVM_ERC20_CONTRACT_ADDRESS",
      `EVM_ERC20_CONTRACT_ADDRESS is set (${env.EVM_ERC20_CONTRACT_ADDRESS})`,
    );
    return;
  }
  env.EVM_ERC20_CONTRACT_ADDRESS = SEPOLIA_USDC;
  console.log(
    `defaulted EVM_ERC20_CONTRACT_ADDRESS=${SEPOLIA_USDC} (real Sepolia USDC — the suites fork Sepolia)`,
  );
}

/**
 * Verify the EVM protocols the vault's circuits call are deployed at `EVM_RPC_URL`: the Uniswap
 * SwapRouter02 behind the swap flows, and the stataUSDC wrapper behind the supply/redeem flows.
 * Both are pinned Sepolia addresses, so an absent one is a fork misconfiguration, and catching it
 * here turns what would surface as an opaque revert deep inside a spec into one pointed failure.
 * The two probes are independent reads, so they run concurrently and both report together.
 *
 * @param env - The suite's env accumulator (reads `EVM_RPC_URL`).
 * @throws {Error} If either contract has no code at `EVM_RPC_URL`, naming every missing one.
 */
async function verifyForkDependencies(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const [uniswap, stata] = await Promise.all([uniswapAvailable(rpcUrl), stataAvailable(rpcUrl)]);
  const missing: string[] = [];
  if (!uniswap) missing.push(`${UNISWAP_SWAP_ROUTER_02} (Uniswap SwapRouter02)`);
  if (!stata) missing.push(`${STATA_USDC} (stataUSDC wrapper)`);
  if (missing.length > 0) {
    throw new Error(
      `no code on ${rpcUrl} at ${missing.join(" and at ")}: the suites run against a Sepolia ` +
        `fork that deploys both, so either SEPOLIA_FORK_RPC_URL is not a Sepolia endpoint or ` +
        `SEPOLIA_FORK_BLOCK is pinned before the contract was deployed.`,
    );
  }
  console.log(
    `fork dependencies present on ${rpcUrl}: Uniswap SwapRouter02 ${UNISWAP_SWAP_ROUTER_02}, ` +
      `stataUSDC wrapper ${STATA_USDC}`,
  );
}

// Step names match what the operator greps for and what STEP_THROUGH prompts show.
const STEPS: readonly SetupStep[] = [
  [
    "environment: midnight stack reachable, compact on PATH, EVM_RPC_URL resolved",
    async (env) => {
      defaultEvmRpcUrl(env);
      await assertEnvironment(env);
    },
  ],
  ["setup: resolve/generate wallet seeds (root + deployer/user/mpc responder)", ensureWalletSeeds],
  ["setup: preflight root funding + fund the role wallets from root", ensureWalletsFunded],
  ["setup: resolve EVM chain id from EVM_RPC_URL", resolveEvmChain],
  ["setup: default EVM_ERC20_CONTRACT_ADDRESS to real Sepolia USDC", ensureErc20Address],
  ["setup: check/derive MPC root key", ensureMpcRootKey],
  ["setup: check/derive MPC_ROOT_PUBLIC_KEY public key", ensureMpcSecp256k1Pubkey],
  ["setup: deploy signet contract", deploySignetContractStep],
  ["setup: persist fakenet hand-off values to .env (append-only)", persistFakenetHandoffToDotEnv],
  ["setup: start the fakenet responder (docker compose)", startFakenetResponder],
  [
    "setup: compile vault contract with proving keys",
    (env) =>
      compileContractZk(env, {
        addressEnvVar: "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
        rootScript: "compile:erc20-vault:zk",
        keysDir: "examples/erc20-vault/contract/src/managed/erc20-vault/keys",
      }),
  ],
  ["setup: deploy vault contract", deployVaultContractStep],
  [
    "setup: check/derive MPC_VAULT_RESPONSE_PUBLIC_KEY for the vault contract",
    (env) => {
      ensureMpcResponseKey(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
    },
  ],
  ["setup: check/derive vault EVM address", ensureVaultEvmAddress],
  ["setup: check/derive user EVM address", ensureUserEvmAddress],
  ["setup: deal derived EVM accounts on the Sepolia fork (ETH + real USDC)", dealForkEvmAccounts],
  ["setup: verify fork dependencies (Uniswap router + stataUSDC wrapper)", verifyForkDependencies],
  [
    "setup: print MPC server configuration",
    (env) => {
      printMpcServerConfig(env, PIPELINE_KEYS);
    },
  ],
];

/**
 * The vitest globalSetup entrypoint: run the example's setup pipeline and
 * provide the populated env accumulator to the flow-test workers.
 *
 * @param project - The vitest project handed to globalSetup.
 * @throws {Error} Whatever the first failing step throws (aborting the whole run).
 */
export async function setup(project: TestProject): Promise<void> {
  await runSetupPipeline(project, STEPS);
}
