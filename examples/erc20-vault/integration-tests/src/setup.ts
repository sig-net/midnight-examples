// The example's vitest globalSetup: compose the ordered setup pipeline
// (environment check -> wallet seeds + root funding -> user 1 EVM wallet seed
// -> EVM chain + test token -> MPC key derivation -> signet deploy -> fakenet
// responder hand-off -> vault zk compile + deploy -> MPC response key ->
// derived EVM addresses -> fork dealing -> MPC hand-off printout) from the harness's generic steps
// plus the vault-specific steps below, and run it via `runSetupPipeline` in
// vitest's main process. The signet contract needs no zk-compile step: its
// proving keys ship inside the published @sig-net/midnight-contract package
// the deploy reads them from. The MPC response key step runs AFTER the vault
// deploy: the key derives from the vault's own contract address, and the
// initialize flow pins it on-chain.

import { parseSeed } from "@midnight-examples/lib";
import {
  appendRepoDotEnv,
  assertEnvironment,
  compileContractZk,
  deploySignetContractStep,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureWalletSeeds,
  ensureWalletsFunded,
  generateHexSeed,
  logSkip,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  requireEnv,
  resolveEvmChain,
  retryWhileDustGenerates,
  runCommand,
  runSetupPipeline,
  type SetupStep,
  startFakenetResponder,
} from "@midnight-examples/test-harness";
import { deriveEvmAddress } from "@sig-net/midnight";
import { HDNodeWallet } from "ethers";
import type { TestProject } from "vitest/node";

import { dealForkEvmAccounts, SEPOLIA_USDC } from "./fork-funding.ts";
import { VAULT_PATH_HEX } from "./mpc-routing.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

const MINUTE = 60_000;

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
  "EVM_USER1_WALLET_ACCOUNT_ADDRESS",
] as const;

/**
 * Deploy the vault contract via the contract package's own `deploy`
 * entrypoint (a subprocess — deploy.ts is a self-executing Node script
 * outside the package's export surface), capturing the printed address.
 * Skips when `MIDNIGHT_VAULT_CONTRACT_ADDRESS` is already set. Retries while
 * the deployer wallet's dust is still generating on a young chain (the
 * failure text survives into the subprocess error message, so the harness's
 * transient-failure matcher still applies).
 *
 * @param env - The suite's env accumulator (the deploy reads
 *   `MIDNIGHT_DEPLOYER_WALLET_SEED`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` and
 *   node config from it, and seals the deployer seed bytes' commitment as
 *   the initialize gate).
 * @throws {Error} If the deploy subprocess fails (after the dust-generation retries)
 *   or its output carries no contract address.
 */
async function deployVaultContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip(
      "deploy vault contract",
      `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`,
    );
    return;
  }
  const contractAddress = await retryWhileDustGenerates("deploy vault contract", async () => {
    const stdout = await runCommand(
      "yarn",
      ["workspace", "@midnight-examples/erc20-vault-contract", "deploy"],
      env,
      10 * MINUTE,
    );
    const address = /deployed erc20-vault at (\S+)/.exec(stdout)?.[1];
    if (address === undefined) {
      throw new Error(
        "vault deploy succeeded but printed no `deployed erc20-vault at <address>` line",
      );
    }
    return address;
  });
  env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
  console.log(
    ` ➜ 💡 Set as MIDNIGHT_VAULT_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`,
  );
}

/**
 * Ensure `EVM_VAULT_ACCOUNT_ADDRESS` matches the vault's derived EVM account
 * (`MPC_ROOT_PUBLIC_KEY` + vault contract address, path = the hex rendering
 * of the contract-fixed `pad(32, "vault")` bytes), deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_VAULT_ACCOUNT_ADDRESS` mismatches the derivation.
 */
function ensureVaultEvmAccountAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_ROOT_PUBLIC_KEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    VAULT_PATH_HEX,
  );
  if (env.EVM_VAULT_ACCOUNT_ADDRESS) {
    console.log(
      `Found EVM_VAULT_ACCOUNT_ADDRESS in the environment as ${env.EVM_VAULT_ACCOUNT_ADDRESS}`,
    );
    if (env.EVM_VAULT_ACCOUNT_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_VAULT_ACCOUNT_ADDRESS should be derived from MPC_ROOT_PUBLIC_KEY + vault contract address: expected ${expectedAddress}, found ${env.EVM_VAULT_ACCOUNT_ADDRESS}`,
      );
    }
    logSkip("check/derive vault EVM account", `EVM_VAULT_ACCOUNT_ADDRESS is set correctly`);
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
 * Ensure `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS` matches user 1's derived EVM deposit
 * account (`MPC_ROOT_PUBLIC_KEY` + vault contract address, path = the hex
 * rendering of the user's identity commitment), deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS` mismatches the derivation.
 */
function ensureUser1EvmDepositAddress(env: NodeJS.ProcessEnv): void {
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
    if (env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS should be derived from MPC_ROOT_PUBLIC_KEY + vault contract + user identity: expected ${expectedAddress}, found ${env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS}`,
      );
    }
    logSkip(
      "check/derive user 1 EVM deposit address",
      `EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS is set correctly`,
    );
    return;
  }
  env.EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS=${expectedAddress}`);
  console.log(` ➜ user 1's derived EVM deposit account (path = identity commitment)`);
  console.log(
    ` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit) — automatic on the local dev chain`,
  );
  console.log(
    ` ➜ 💡 Set as EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS in the environment to skip this step on the next run`,
  );
}

/**
 * Ensure `EVM_USER1_WALLET_SEED` is set: reuse the one in `.env` when
 * present, otherwise generate a fresh 32-byte hex seed and persist it
 * (append-only). Deliberately independent of the Midnight seeds: user 1's
 * two wallets are two real wallets, one per chain.
 *
 * @param env - The suite's env accumulator.
 */
function ensureUser1EvmWalletSeed(env: NodeJS.ProcessEnv): void {
  if (env.EVM_USER1_WALLET_SEED?.trim()) {
    logSkip("resolve user 1 EVM wallet seed", "EVM_USER1_WALLET_SEED is set — reusing it");
    return;
  }
  env.EVM_USER1_WALLET_SEED = generateHexSeed();
  console.log("generated user 1 EVM wallet seed -> EVM_USER1_WALLET_SEED (persisted to .env)");
  appendRepoDotEnv(
    { EVM_USER1_WALLET_SEED: env.EVM_USER1_WALLET_SEED },
    "erc20-vault setup: generated EVM wallet seed (user 1)",
  );
}

// The BIP-44 path user 1's EVM wallet derives at: coin type 60, account 0,
// external chain, index 0 — the first account a standard EVM wallet opens
// for a seed.
const WALLET_DERIVATION_PATH = "m/44'/60'/0'/0/0";

/**
 * Ensure `EVM_USER1_WALLET_ACCOUNT_ADDRESS` matches the EVM account user 1's wallet
 * derives from `EVM_USER1_WALLET_SEED` (BIP-44,
 * {@link WALLET_DERIVATION_PATH}), deriving it when absent. Funding this
 * account is what makes the seed a spendable wallet on the EVM side.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_USER1_WALLET_ACCOUNT_ADDRESS` mismatches the derivation.
 */
function ensureUser1EvmWalletAddress(env: NodeJS.ProcessEnv): void {
  const { seed } = parseSeed(requireEnv(env, "EVM_USER1_WALLET_SEED"));
  const expectedAddress = HDNodeWallet.fromSeed(seed).derivePath(
    WALLET_DERIVATION_PATH.replace(/^m\//, ""),
  ).address;
  if (env.EVM_USER1_WALLET_ACCOUNT_ADDRESS) {
    console.log(
      `Found EVM_USER1_WALLET_ACCOUNT_ADDRESS in the environment as ${env.EVM_USER1_WALLET_ACCOUNT_ADDRESS}`,
    );
    if (env.EVM_USER1_WALLET_ACCOUNT_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_USER1_WALLET_ACCOUNT_ADDRESS should be the ${WALLET_DERIVATION_PATH} derivation of EVM_USER1_WALLET_SEED: expected ${expectedAddress}, found ${env.EVM_USER1_WALLET_ACCOUNT_ADDRESS}`,
      );
    }
    logSkip(
      "check/derive user 1 EVM wallet address",
      `EVM_USER1_WALLET_ACCOUNT_ADDRESS is set correctly`,
    );
    return;
  }
  env.EVM_USER1_WALLET_ACCOUNT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_USER1_WALLET_ACCOUNT_ADDRESS=${expectedAddress}`);
  console.log(
    ` ➜ the EVM account user 1's wallet derives from EVM_USER1_WALLET_SEED (${WALLET_DERIVATION_PATH})`,
  );
  console.log(` ➜ install EVM_USER1_WALLET_SEED in any standard EVM wallet to hold this account`);
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

// Step names match what the operator greps for and what STEP_THROUGH prompts show.
const STEPS: readonly SetupStep[] = [
  [
    "environment: midnight stack reachable, compact on PATH, EVM_RPC_URL resolved",
    async (env) => {
      defaultEvmRpcUrl(env);
      await assertEnvironment(env);
    },
  ],
  [
    "setup: resolve/generate Midnight wallet seeds (root + deployer/user 1/mpc responder/user 2)",
    ensureWalletSeeds,
  ],
  ["setup: preflight root funding + fund the Midnight wallets from root", ensureWalletsFunded],
  ["setup: resolve/generate user 1 EVM wallet seed", ensureUser1EvmWalletSeed],
  ["setup: resolve EVM chain id from EVM_RPC_URL", resolveEvmChain],
  ["setup: default EVM_ERC20_CONTRACT_ADDRESS to real Sepolia USDC", ensureErc20Address],
  ["setup: check/derive MPC root private key", ensureMpcRootKey],
  ["setup: check/derive MPC_ROOT_PUBLIC_KEY", ensureMpcSecp256k1Pubkey],
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
  ["setup: check/derive vault EVM account address", ensureVaultEvmAccountAddress],
  ["setup: check/derive user 1 EVM deposit address", ensureUser1EvmDepositAddress],
  ["setup: check/derive user 1 EVM wallet address", ensureUser1EvmWalletAddress],
  [
    "setup: deal the example's EVM accounts on the Sepolia fork (ETH + real USDC)",
    dealForkEvmAccounts,
  ],
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
