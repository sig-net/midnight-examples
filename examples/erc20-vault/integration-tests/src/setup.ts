// The example's vitest globalSetup: compose the ordered setup pipeline
// (environment check -> wallet seeds + root funding -> EVM chain + test token
// -> MPC key derivation -> signet deploy -> fakenet responder hand-off ->
// vault zk compile + deploy -> MPC response key -> derived EVM addresses ->
// local funding -> MPC hand-off printout) from the harness's generic steps
// plus the vault-specific steps below, and run it via `runSetupPipeline` in
// vitest's main process. The signet contract needs no zk-compile step: its
// proving keys ship inside the published @sig-net/midnight-contract package
// the deploy reads them from. The MPC response key step runs AFTER the vault
// deploy: the key derives from the vault's own contract address, and the
// initialize flow pins it on-chain.

import type { TestProject } from "vitest/node";

import {
  assertEnvironment,
  compileContractZk,
  deploySignetContractStep,
  ensureErc20Deployed,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureWalletSeeds,
  ensureWalletsFunded,
  fundLocalEvmAccounts,
  logSkip,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  requireEnv,
  resolveEvmChain,
  retryDeployWhileDustGenerates,
  runCommand,
  runSetupPipeline,
  startFakenetResponder,
  type SetupStep,
} from "@midnight-examples/test-harness";
import { bytesToHex, deriveEvmAddress } from "@sig-net/midnight";

import { deployTestUsdc } from "./test-usdc.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

const MINUTE = 60_000;

// The derived EVM accounts the local-chain funding step tops up.
const DERIVED_EVM_ADDRESS_ENV_VARS = ["EVM_USER_ADDRESS", "EVM_VAULT_ADDRESS"] as const;

// The env keys the setup steps populate, in derivation order — the "Minimal
// .env block" printout reads like the flow that produced it.
const PIPELINE_KEYS = [
  "EVM_CHAIN_ID",
  "ERC20_ADDRESS",
  "MPC_ROOT_KEY",
  "MPC_SECP256K1_PUBKEY",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MPC_RESPONSE_KEY",
  "EVM_VAULT_ADDRESS",
  "EVM_USER_ADDRESS",
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
 * @param env - The suite's env accumulator (the deploy reads `DEPLOYER_SEED`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` and node config from it).
 * @throws If the deploy subprocess fails (after the dust-generation retries)
 *   or its output carries no contract address.
 */
async function deployVaultContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip("deploy vault contract", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
    return;
  }
  // The deploy seals the DEPLOYER identity commitment into the contract and
  // `initialize` is deployer-gated, while the flows drive the identity-gated
  // circuits AS THE USER. The wallets are split roles (the deployer wallet
  // pays, the user wallet drives), so keep the IDENTITIES equal by sealing
  // the user's: default VAULT_DEPLOYER_SECRET_KEY to the user identity
  // secret unless the operator pinned it explicitly.
  if (!env.VAULT_DEPLOYER_SECRET_KEY) {
    env.VAULT_DEPLOYER_SECRET_KEY = bytesToHex(resolveUserIdentity(env).secretKey);
    console.log("defaulted VAULT_DEPLOYER_SECRET_KEY to the user identity secret (initialize is deployer-gated)");
  }
  const contractAddress = await retryDeployWhileDustGenerates("deploy vault contract", async () => {
    const stdout = await runCommand(
      "yarn",
      ["workspace", "@midnight-examples/erc20-vault-contract", "deploy"],
      env,
      10 * MINUTE,
    );
    const match = stdout.match(/deployed erc20-vault at (\S+)/);
    if (!match) {
      throw new Error("vault deploy succeeded but printed no `deployed erc20-vault at <address>` line");
    }
    return match[1];
  });
  env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
  console.log(` ➜ 💡 Set as MIDNIGHT_VAULT_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

/**
 * Ensure `EVM_VAULT_ADDRESS` matches the vault's derived EVM account
 * (`MPC_SECP256K1_PUBKEY` + vault contract address, path `"vault"`),
 * deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws If a preset `EVM_VAULT_ADDRESS` mismatches the derivation.
 */
function ensureVaultEvmAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    "vault",
  );
  if (env.EVM_VAULT_ADDRESS) {
    console.log(`Found EVM_VAULT_ADDRESS in the environment as ${env.EVM_VAULT_ADDRESS}`);
    if (env.EVM_VAULT_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_VAULT_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract address: expected ${expectedAddress}, found ${env.EVM_VAULT_ADDRESS}`,
      );
    }
    logSkip("check/derive vault EVM address", `EVM_VAULT_ADDRESS is set correctly`);
    return;
  }
  env.EVM_VAULT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_VAULT_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the vault's own EVM account (path "vault")`);
  console.log(` ➜ fund it with ETH for gas before running withdrawals (automatic on the local dev chain)`);
  console.log(` ➜ 💡 Set as EVM_VAULT_ADDRESS in the environment to skip this step on the next run`);
}

/**
 * Ensure `EVM_USER_ADDRESS` matches the user's derived EVM account
 * (`MPC_SECP256K1_PUBKEY` + vault contract address, path = the user identity
 * commitment read as the MPC's path string), deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws If a preset `EVM_USER_ADDRESS` mismatches the derivation.
 */
function ensureUserEvmAddress(env: NodeJS.ProcessEnv): void {
  const identity = resolveUserIdentity(env);
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    identity.pathString,
  );
  if (env.EVM_USER_ADDRESS) {
    console.log(`Found EVM_USER_ADDRESS in the environment as ${env.EVM_USER_ADDRESS}`);
    if (env.EVM_USER_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_USER_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract + user identity: expected ${expectedAddress}, found ${env.EVM_USER_ADDRESS}`,
      );
    }
    logSkip("check/derive user EVM address", `EVM_USER_ADDRESS is set correctly`);
    return;
  }
  env.EVM_USER_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_USER_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the user's derived EVM account (path = identity commitment)`);
  console.log(
    ` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit) — automatic on the local dev chain`,
  );
  console.log(` ➜ 💡 Set as EVM_USER_ADDRESS in the environment to skip this step on the next run`);
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

/** Step names match what the operator greps for and what STEP_THROUGH prompts show. */
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
  ["setup: check/deploy ERC20 token on the EVM chain", (env) => ensureErc20Deployed(env, deployTestUsdc)],
  ["setup: check/derive MPC root key", ensureMpcRootKey],
  ["setup: check/derive MPC_SECP256K1_PUBKEY public key", ensureMpcSecp256k1Pubkey],
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
    "setup: check/derive MPC_RESPONSE_KEY for the vault contract",
    (env) => ensureMpcResponseKey(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
  ],
  ["setup: check/derive vault EVM address", ensureVaultEvmAddress],
  ["setup: check/derive user EVM address", ensureUserEvmAddress],
  [
    "setup: fund derived EVM accounts (local chain only)",
    (env) => fundLocalEvmAccounts(env, DERIVED_EVM_ADDRESS_ENV_VARS),
  ],
  ["setup: print MPC server configuration", (env) => printMpcServerConfig(env, PIPELINE_KEYS)],
];

/**
 * The vitest globalSetup entrypoint: run the example's setup pipeline and
 * provide the populated env accumulator to the flow-test workers.
 *
 * @param project - The vitest project handed to globalSetup.
 * @throws Whatever the first failing step throws (aborting the whole run).
 */
export async function setup(project: TestProject): Promise<void> {
  await runSetupPipeline(project, STEPS);
}
