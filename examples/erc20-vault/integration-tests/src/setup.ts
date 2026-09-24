// The example's setup pipeline: compose the ordered steps
// (environment check -> wallet seeds + root funding -> EVM chain + output
// source + trace RPC check + test token -> MPC key derivation -> signet deploy -> fakenet responder hand-off ->
// vault zk compile + deploy -> MPC response key -> derived EVM addresses ->
// vault initialise -> fork dealing -> fork dependency check -> MPC hand-off printout) from the
// harness's generic steps plus the vault-specific steps below. The vitest
// globalSetup `setup` runs it via `runSetupPipeline` in vitest's main process,
// and `scripts/setup-local.ts` runs the same steps outside vitest to bring up
// a local stack by hand. The signet contract needs no zk-compile step: its
// proving keys ship inside the published @sig-net/midnight-contract package
// the deploy reads them from. The MPC response key step runs AFTER the vault
// deploy: the key derives from the vault's own contract address, and the
// initialise flow pins it on-chain.

import {
  bytesToHex,
  deriveEvmAddress,
  formatSecp256k1PublicKey,
  getMpcOutputCacheUrl,
  normaliseSecp256k1PublicKey,
} from "@sig-net/midnight";
import {
  deployedNetwork,
  generateHexSeed,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  type WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  deriveVaultEvmAddress,
  printVaultState,
  readVaultLedger,
  STATA_USDC,
  UNISWAP_SWAP_ROUTER_02,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  deployVault,
  InitialiseVaultOutcome,
  resolveInitialiseConfig,
  resumeVaultDeploy,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
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
  explainDustSpendRejection,
  logSkip,
  optionalEnv,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  requireEnv,
  resolveEvmChain,
  runSetupPipeline,
  type SetupStep,
  startFakenetResponder,
} from "@sig-net/midnight-examples-test-harness";
import type { TestProject } from "vitest/node";

import { stataAvailable } from "./evm-stata.ts";
import { uniswapAvailable } from "./evm-swap.ts";
import { initialise } from "./flows/initialise.ts";
import { dealForkEvmAccounts, SEPOLIA_USDC } from "./fork-funding.ts";
import { assertDebugTraceAvailable } from "./observed-execution.ts";
import { OutputSource, parseOutputSource } from "./output-source.ts";
import { resolveUserIdentity } from "./vault-identity.ts";
import { createVaultSession } from "./vault-session.ts";

/**
 * The env keys the setup steps populate beyond the wallet seeds, in
 * derivation order, so the "Minimal .env block" printout reads like the flow
 * that produced it and `scripts/setup-local.ts` persists them in that order.
 * The two secrets are present only on the run that deploys the vault (a
 * rerun against a kept address reads them from `.env` or leaves them unset).
 */
export const VAULT_PIPELINE_KEYS = [
  "EVM_CHAIN_ID",
  "ERC20_ADDRESS",
  "MPC_ROOT_KEY",
  "MPC_SECP256K1_PUBKEY",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "VAULT_DEPLOYER_SECRET_KEY",
  "MAINTENANCE_SIGNING_KEY",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MPC_RESPONSE_KEY",
  "EVM_VAULT_ADDRESS",
  "EVM_USER_ADDRESS",
] as const;

/**
 * Deploy the vault contract by calling the deploy package's `deployVault`
 * in-process: the same function the `deploy` and `deploy-initialise`
 * entrypoints run, so the split deploy (base deploy plus one maintenance
 * update per deferred circuit) this suite exercises is the one a remote
 * bring-up performs. The address is appended to `.env` the moment the base
 * deploy is submitted, before any maintenance add, so a run that dies
 * mid-deploy leaves `MIDNIGHT_VAULT_CONTRACT_ADDRESS` set. With the address
 * set, this step runs the deploy package's `resumeVaultDeploy` instead: it
 * installs whatever circuits the vault still lacks, and passes straight
 * through on a vault with every circuit.
 *
 * On the local chain the maintenance authority the base deploy seals is
 * generated INTO the accumulator here, so the printout and the local setup
 * entrypoint can hand it to a later `resume-deploy`. A deployed network
 * must supply `MAINTENANCE_SIGNING_KEY` itself: the deploy refuses to run
 * without it.
 *
 * @param env - The suite's env accumulator (the deploy reads `DEPLOYER_SEED`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`, `MAINTENANCE_SIGNING_KEY` and node
 *   config from it).
 * @param wallets - The pipeline's registry, holding the deployer wallet the funding step synced.
 * @throws {SplitDeployAfterBaseSubmitError} If the deploy failed after its base
 *   deploy was submitted. Its address is already in `.env`, so the next run
 *   resumes it.
 * @throws {Error} If the deploy or the resume fails otherwise.
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
    console.log(
      `resumed the deploy of MIDNIGHT_VAULT_CONTRACT_ADDRESS=${presetAddress}: installed ${installed.join(", ")}`,
    );
    return;
  }
  // The deploy seals the DEPLOYER identity commitment into the contract and
  // `initialise` is deployer-gated, while the flows drive the identity-gated
  // circuits AS THE USER. The wallets are split roles (the deployer wallet
  // pays, the user wallet drives), so keep the IDENTITIES equal by sealing
  // the user's: default VAULT_DEPLOYER_SECRET_KEY to the user identity
  // secret unless the operator pinned it explicitly.
  if (!env.VAULT_DEPLOYER_SECRET_KEY) {
    env.VAULT_DEPLOYER_SECRET_KEY = bytesToHex(resolveUserIdentity(env).secretKey);
    console.log(
      "defaulted VAULT_DEPLOYER_SECRET_KEY to the user identity secret (initialise is deployer-gated)",
    );
  }
  if (
    !env.MAINTENANCE_SIGNING_KEY &&
    isLocalStandaloneNetwork(getMidnightNodeConfig(env).networkId)
  ) {
    env.MAINTENANCE_SIGNING_KEY = generateHexSeed();
    console.log(
      `generated MAINTENANCE_SIGNING_KEY=${env.MAINTENANCE_SIGNING_KEY} for the local split deploy`,
    );
    console.log(
      " ➜ the sealed maintenance authority: export it to `yarn resume-deploy:erc20-vault` if a maintenance add fails",
    );
  }
  const { contractAddress } = await explainDustSpendRejection("deploy vault contract", () =>
    deployVault(env, wallets, (baseAddress) => {
      env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = baseAddress;
      appendRepoDotEnv(
        { MIDNIGHT_VAULT_CONTRACT_ADDRESS: baseAddress },
        `appended by the erc20-vault setup (${new Date().toISOString()}): base deploy submitted, a rerun resumes the circuit installs`,
      );
      console.log(`appended MIDNIGHT_VAULT_CONTRACT_ADDRESS=${baseAddress} to .env`);
      console.log(` ➜ a rerun with it set resumes the circuit installs from here`);
    }),
  );
  console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
  console.log(` ➜ 💡 already in .env, so the next run skips compile + deploy`);
}

/**
 * Ensure `EVM_VAULT_ADDRESS` matches the vault's derived EVM account, deriving
 * it when absent. The derivation is the contract package's
 * {@link deriveVaultEvmAddress}, the same one the deploy package's
 * `resolveInitialiseConfig` seals on-chain, so this step and the initialise
 * agree by construction.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_VAULT_ADDRESS` mismatches the derivation.
 */
function ensureVaultEvmAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveVaultEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
  );
  if (env.EVM_VAULT_ADDRESS) {
    console.log(`Found EVM_VAULT_ADDRESS in the environment as ${env.EVM_VAULT_ADDRESS}`);
    // Case-insensitive: an EVM address is EIP-55 checksummed, so the same
    // account differs only in case between one speller and another.
    if (env.EVM_VAULT_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
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
  console.log(
    ` ➜ fund it with ETH for gas before running withdrawals (automatic on the local dev chain)`,
  );
  console.log(
    ` ➜ 💡 Set as EVM_VAULT_ADDRESS in the environment to skip this step on the next run`,
  );
}

/**
 * Ensure `EVM_USER_ADDRESS` matches the user's derived EVM account
 * (`MPC_SECP256K1_PUBKEY` + vault contract address, path = the hex rendering
 * of the user's identity commitment), deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset `EVM_USER_ADDRESS` mismatches the derivation.
 */
function ensureUserEvmAddress(env: NodeJS.ProcessEnv): void {
  const identity = resolveUserIdentity(env);
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    identity.commitmentHex,
  );
  if (env.EVM_USER_ADDRESS) {
    console.log(`Found EVM_USER_ADDRESS in the environment as ${env.EVM_USER_ADDRESS}`);
    if (env.EVM_USER_ADDRESS.toLowerCase() !== expectedAddress.toLowerCase()) {
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
    ` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (funding reserve) and >= 0.1 USDC (deposit) — automatic on the local dev chain`,
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

/**
 * The output cache the SDK publishes for the run's network: what
 * `RESPOND_OUTPUT_SOURCE=mpc-cache` reads when `MPC_OUTPUT_CACHE_URL` is
 * unset.
 *
 * @param env - The suite's env accumulator (`NETWORK_ID` and its overrides).
 * @returns The published cache URL.
 * @throws {Error} On the local stack, which has no published cache, or on a
 *   deployed network the SDK publishes none for yet.
 */
function publishedMpcOutputCacheUrl(env: NodeJS.ProcessEnv): string {
  const deployed = deployedNetwork(getMidnightNodeConfig(env).networkId);
  if (deployed === undefined) {
    throw new Error(
      `RESPOND_OUTPUT_SOURCE=${OutputSource.MPCCache} on the local stack needs MPC_OUTPUT_CACHE_URL: ` +
        "no cache is published for it (the compose fakenet serves one at http://127.0.0.1:3040/v1/fakenet)",
    );
  }
  return getMpcOutputCacheUrl(deployed);
}

/**
 * Default `RESPOND_OUTPUT_SOURCE` to the EVM node's trace when unset: the
 * attestation polls then recompute each attested output from the mined
 * transaction. A run against an MPC with an output cache sets `mpc-cache`,
 * reading the cache the SDK publishes for the network unless
 * `MPC_OUTPUT_CACHE_URL` names one (the local fakenet's simulation, say), and
 * a set value is validated here so a misconfiguration fails before anything
 * is deployed.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If `RESPOND_OUTPUT_SOURCE` names no source, or names the
 *   cache on a network with neither `MPC_OUTPUT_CACHE_URL` nor a published
 *   cache.
 */
function ensureRespondOutputSource(env: NodeJS.ProcessEnv): void {
  if (!env.RESPOND_OUTPUT_SOURCE) {
    env.RESPOND_OUTPUT_SOURCE = OutputSource.EVMNode;
    console.log(
      `defaulted RESPOND_OUTPUT_SOURCE=${env.RESPOND_OUTPUT_SOURCE} (attested outputs recomputed from the EVM node's trace)`,
    );
    return;
  }
  const source = parseOutputSource(env.RESPOND_OUTPUT_SOURCE);
  if (source === OutputSource.MPCCache) {
    const cacheUrl = optionalEnv(env, "MPC_OUTPUT_CACHE_URL") ?? publishedMpcOutputCacheUrl(env);
    logSkip(
      "default RESPOND_OUTPUT_SOURCE",
      `RESPOND_OUTPUT_SOURCE is set (${source}): attested outputs read from ${cacheUrl}`,
    );
    return;
  }
  logSkip("default RESPOND_OUTPUT_SOURCE", `RESPOND_OUTPUT_SOURCE is set (${source})`);
}

/**
 * Refuse an `EVM_RPC_URL` without `debug_traceTransaction` when the deposit
 * and withdraw polls recompute attested outputs from the trace. Under
 * `mpc-cache` those polls read the MPC's output cache, so a non-tracing
 * endpoint is accepted; the swap, supply and redeem polls always trace, and
 * their specs fail on such an endpoint at the poll.
 *
 * @param env - The suite's env accumulator (reads `RESPOND_OUTPUT_SOURCE` and `EVM_RPC_URL`).
 * @throws {Error} If the source is the EVM node and the endpoint refuses the method.
 */
async function verifyTraceRpc(env: NodeJS.ProcessEnv): Promise<void> {
  if (parseOutputSource(requireEnv(env, "RESPOND_OUTPUT_SOURCE")) === OutputSource.MPCCache) {
    logSkip(
      "verify EVM_RPC_URL serves debug_traceTransaction",
      `RESPOND_OUTPUT_SOURCE=${OutputSource.MPCCache}: the deposit and withdraw polls read the MPC's output cache`,
    );
    console.log(
      " ➜ the swap, supply and redeem polls still trace, so their specs need a tracing EVM_RPC_URL",
    );
    return;
  }
  await assertDebugTraceAvailable(requireEnv(env, "EVM_RPC_URL"));
}

/**
 * Default `ERC20_ADDRESS` to real Sepolia USDC — the suites run against a Sepolia fork, so the
 * token is the real (unmintable) USDC rather than a locally deployed test token. Any other
 * ERC20 with a standard balance mapping (dealable by storage write) can be pinned explicitly.
 *
 * @param env - The suite's env accumulator.
 */
function ensureErc20Address(env: NodeJS.ProcessEnv): void {
  if (env.ERC20_ADDRESS) {
    logSkip("default ERC20_ADDRESS", `ERC20_ADDRESS is set (${env.ERC20_ADDRESS})`);
    return;
  }
  env.ERC20_ADDRESS = SEPOLIA_USDC;
  console.log(
    `defaulted ERC20_ADDRESS=${SEPOLIA_USDC} (real Sepolia USDC — the suites fork Sepolia)`,
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
      `no code on ${rpcUrl} at ${missing.join(" and at ")}: the suites run against Sepolia ` +
        `(the local anvil fork, or the real network), which deploys both, so either EVM_RPC_URL ` +
        `is not a Sepolia endpoint, SEPOLIA_FORK_RPC_URL is not one, or SEPOLIA_FORK_BLOCK is ` +
        `pinned before the contract was deployed.`,
    );
  }
  console.log(
    `fork dependencies present on ${rpcUrl}: Uniswap SwapRouter02 ${UNISWAP_SWAP_ROUTER_02}, ` +
      `stataUSDC wrapper ${STATA_USDC}`,
  );
}

/**
 * Call the vault's `initialise` circuit through the same session-shaped flow
 * the suites drive (the deployer-gated one-off sealing the vault's EVM
 * address, chain, EVM targets and MPC response key), then verify the sealed
 * ledger state against the resolved config — the invariants every flow file
 * assumes. Running it here instead of as happy-day's first test makes every
 * flow file independent of file order, which is what lets the gate run
 * sharded across jobs against separate stacks.
 *
 * @param env - The suite's env accumulator (reads everything the deploy
 *   package's `resolveInitialiseConfig` reads).
 * @throws {Error} If the circuit rejects the caller, or the sealed ledger
 *   state contradicts the resolved configuration.
 */
async function initialiseVaultStep(env: NodeJS.ProcessEnv): Promise<void> {
  const session = createVaultSession(env);
  try {
    const context = await session.vaultContext();
    const readLedger = () =>
      readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
    const config = await resolveInitialiseConfig(env, context.vaultContractAddress);
    const outcome = await initialise(context, config);
    if (outcome === InitialiseVaultOutcome.AlreadyInitialised) {
      logSkip(
        "initialise vault contract",
        "vault is already initialised (rerun against a kept contract)",
      );
    }
    await printVaultState(context.providers.publicDataProvider, context.vaultContractAddress);
    const state = await readLedger();
    if (state.initialised !== 1n) {
      throw new Error(
        `the vault ledger reports initialised=${String(state.initialised)}, expected 1n`,
      );
    }
    const sealedVaultEvmAddress = `0x${bytesToHex(state.vaultEvmAddress)}`.toLowerCase();
    if (sealedVaultEvmAddress !== config.vaultEvmAddress.toLowerCase()) {
      throw new Error(
        `the sealed vault EVM address ${sealedVaultEvmAddress} does not match the resolved config ${config.vaultEvmAddress}`,
      );
    }
    const evmChainId = requireEnv(env, "EVM_CHAIN_ID");
    if (state.evmChainId !== BigInt(evmChainId)) {
      throw new Error(
        `the sealed EVM chain id ${String(state.evmChainId)} does not match EVM_CHAIN_ID=${evmChainId}`,
      );
    }
    const sealedResponseKey = formatSecp256k1PublicKey(state.mpcResponseKey);
    const resolvedResponseKey = normaliseSecp256k1PublicKey(config.mpcResponseKey);
    if (sealedResponseKey !== resolvedResponseKey) {
      throw new Error(
        `the sealed MPC response key 0x${sealedResponseKey} does not match the resolved config 0x${resolvedResponseKey}`,
      );
    }
  } finally {
    await session.stop();
  }
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
  ["setup: inspect role wallets and fund empty wallets", ensureWalletsFunded],
  ["setup: resolve EVM chain id from EVM_RPC_URL", resolveEvmChain],
  ["setup: default RESPOND_OUTPUT_SOURCE to the EVM node's trace", ensureRespondOutputSource],
  ["setup: verify EVM_RPC_URL serves debug_traceTransaction", verifyTraceRpc],
  ["setup: default ERC20_ADDRESS to real Sepolia USDC", ensureErc20Address],
  ["setup: check/derive MPC root key", ensureMpcRootKey],
  [
    "setup: check/derive MPC_SECP256K1_PUBKEY public key",
    (env) => {
      ensureMpcSecp256k1Pubkey(env);
    },
  ],
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
    "setup: initialise vault contract (seal vault EVM address + MPC response key)",
    initialiseVaultStep,
  ],
  [
    "setup: deal derived EVM accounts (ETH + real USDC on an anvil fork, funding hints on a real chain)",
    dealForkEvmAccounts,
  ],
  [
    "setup: verify Sepolia dependencies (Uniswap router + stataUSDC wrapper)",
    verifyForkDependencies,
  ],
  [
    "setup: print MPC server configuration",
    (env) => {
      printMpcServerConfig(env, VAULT_PIPELINE_KEYS);
    },
  ],
];

/**
 * The vault's ordered setup steps, shared by the vitest globalSetup below and
 * `scripts/setup-local.ts`.
 *
 * @returns The steps, in run order.
 */
export function vaultSetupSteps(): readonly SetupStep[] {
  return STEPS;
}

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
