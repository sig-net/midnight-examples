import { bytesToHex, deriveEvmAddress } from "@sig-net/midnight";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";
import {
  deriveVaultEvmAddress,
  STATA_USDC,
  UNISWAP_SWAP_ROUTER_02,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  appendRepoDotEnv,
  assertDebugTraceAvailable,
  assertEnvironment,
  compileContractZk,
  deploySignetContractStep,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureWalletSeeds,
  ensureWalletsFunded,
  explainDustSpendRejection,
  getDeployedCode,
  logSkip,
  persistFakenetHandoffToDotEnv,
  requireEnv,
  resolveEvmChain,
  type SetupStep,
  startFakenetResponder,
} from "@sig-net/midnight-examples-lib";

import { deployVault, resumeVaultDeploy } from "./deploy-vault.ts";
import { dealForkEvmAccounts, SEPOLIA_USDC } from "./fork-funding.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

/**
 * Persist the base address before deferred circuit installation so a failed deploy can resume.
 *
 * @param env - Deployment configuration.
 * @param wallets - Setup-owned wallet registry.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
async function deployVaultContractStep(
  env: NodeJS.ProcessEnv,
  wallets: WalletRegistry,
): Promise<void> {
  const presetAddress = env.MIDNIGHT_VAULT_CONTRACT_ADDRESS;
  if (presetAddress) {
    const { installed } = await explainDustSpendRejection("resume vault deploy", () =>
      resumeVaultDeploy(env, presetAddress, wallets),
    );
    if (installed.length === 0) {
      logSkip(
        "deploy vault contract",
        `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${presetAddress}) and every circuit is installed`,
      );
      return;
    }

    return;
  }
  env.VAULT_DEPLOYER_SECRET_KEY ??= bytesToHex(resolveUserIdentity(env).secretKey);
  await explainDustSpendRejection("deploy vault contract", () =>
    deployVault(env, wallets, (baseAddress) => {
      env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = baseAddress;
      appendRepoDotEnv(
        { MIDNIGHT_VAULT_CONTRACT_ADDRESS: baseAddress },
        `appended by the erc20-vault setup (${new Date().toISOString()}): base deploy submitted, a rerun resumes the circuit installs`,
      );
    }),
  );
}

/**
 * Reject an address inconsistent with the deployed vault and configured MPC key.
 *
 * @param env - Deployment configuration.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
function ensureVaultEvmAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveVaultEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
  );
  if (env.EVM_VAULT_ADDRESS) {
    if (env.EVM_VAULT_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `EVM_VAULT_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract address: expected ${expectedAddress}, found ${env.EVM_VAULT_ADDRESS}`,
      );
    }
    logSkip("check/derive vault EVM address", `EVM_VAULT_ADDRESS is set correctly`);
    return;
  }
  env.EVM_VAULT_ADDRESS = expectedAddress;
}

/**
 * Reject an address inconsistent with the selected independent user identity.
 *
 * @param env - Deployment configuration.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
function ensureUserEvmAddress(env: NodeJS.ProcessEnv): void {
  const identity = resolveUserIdentity(env);
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    identity.commitmentHex,
  );
  if (env.EVM_USER_ADDRESS) {
    if (env.EVM_USER_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `EVM_USER_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract + user identity: expected ${expectedAddress}, found ${env.EVM_USER_ADDRESS}`,
      );
    }
    logSkip("check/derive user EVM address", `EVM_USER_ADDRESS is set correctly`);
    return;
  }
  env.EVM_USER_ADDRESS = expectedAddress;
}

/**
 * Supply the local Anvil endpoint when the caller supplies none.
 *
 * @param env - Deployment configuration.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
function defaultEvmRpcUrl(env: NodeJS.ProcessEnv): void {
  env.EVM_RPC_URL ??= "http://127.0.0.1:8545";
}

/**
 * Select the Sepolia deposit token when the caller supplies none.
 *
 * @param env - Deployment configuration.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
function ensureErc20Address(env: NodeJS.ProcessEnv): void {
  if (env.ERC20_ADDRESS) {
    logSkip("default ERC20_ADDRESS", `ERC20_ADDRESS is set (${env.ERC20_ADDRESS})`);
    return;
  }
  env.ERC20_ADDRESS = SEPOLIA_USDC;
}

/**
 * Fail setup when a configured protocol has no deployed bytecode.
 *
 * @param env - Deployment configuration.
 * @throws {Error} When preparation cannot satisfy the configuration.
 */
async function verifyForkDependencies(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const [uniswap, stata] = await Promise.all([
    getDeployedCode(rpcUrl, UNISWAP_SWAP_ROUTER_02),
    getDeployedCode(rpcUrl, STATA_USDC),
  ]);
  const missing: string[] = [];
  if (uniswap === "0x") missing.push(`${UNISWAP_SWAP_ROUTER_02} (Uniswap SwapRouter02)`);
  if (stata === "0x") missing.push(`${STATA_USDC} (stataUSDC wrapper)`);
  if (missing.length > 0) {
    throw new Error(
      `no code on ${rpcUrl} at ${missing.join(" and at ")}: the suites run against Sepolia ` +
        `(the local anvil fork, or the real network), which deploys both, so either EVM_RPC_URL ` +
        `is not a Sepolia endpoint, SEPOLIA_FORK_RPC_URL is not one, or SEPOLIA_FORK_BLOCK is ` +
        `pinned before the contract was deployed.`,
    );
  }
}
const VAULT_SETUP_STEPS: readonly SetupStep[] = [
  [
    "environment: midnight stack reachable, compact on PATH, EVM_RPC_URL resolved",
    async (env) => {
      defaultEvmRpcUrl(env);
      await assertEnvironment(env);
    },
  ],
  ["setup: resolve/generate wallet seeds (root + deployer/user/mpc responder)", ensureWalletSeeds],
  ["setup: inspect role wallets and fund empty wallets", ensureWalletsFunded],
  ["setup: resolve EVM chain id from EVM_RPC_URL", resolveEvmChain],
  [
    "setup: verify EVM_RPC_URL serves debug_traceTransaction",
    (env) => assertDebugTraceAvailable(requireEnv(env, "EVM_RPC_URL")),
  ],
  ["setup: default ERC20_ADDRESS to real Sepolia USDC", ensureErc20Address],
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
    (env) => {
      ensureMpcResponseKey(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
    },
  ],
  ["setup: check/derive vault EVM address", ensureVaultEvmAddress],
  ["setup: check/derive user EVM address", ensureUserEvmAddress],
  [
    "setup: deal derived EVM accounts (ETH + real USDC on an anvil fork, funding hints on a real chain)",
    dealForkEvmAccounts,
  ],
  [
    "setup: verify Sepolia dependencies (Uniswap router + stataUSDC wrapper)",
    verifyForkDependencies,
  ],
];

/**
 * Return the ordered vault preparation consumed by deployment commands and integration setup.
 *
 * @returns The shared setup sequence.
 */
export function vaultSetupSteps(): readonly SetupStep[] {
  return VAULT_SETUP_STEPS;
}
