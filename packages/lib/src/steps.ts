import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  deriveMidnightResponseKey,
  formatSecp256k1PublicKey,
  normaliseSecp256k1PublicKey,
} from "@sig-net/midnight";
import {
  CounterpartyOrigin,
  deploySignetContract,
  findMpcRootPublicKey,
  findSignetContractAddress,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  type WalletRegistry,
} from "@sig-net/midnight-contract-deploy";

import { loadRepoDotEnv, REPO_ROOT } from "./env-file.ts";
import { appendRepoDotEnv } from "./env-file.ts";
import { requireEnv } from "./environment.ts";
import { getEvmChainId } from "./evm-queries.ts";
import { runCommand, runRootScript } from "./exec.ts";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";
import { MpcKind, mpcKind } from "./mpc-kind.ts";
import { logSkip } from "./output.ts";
import { assertCommandAvailable, assertHttpReachable } from "./preflight.ts";

const MINUTE = 60_000;

/**
 * How a resolved MPC root public key reads in the setup log: the variable
 * that set it, or the SDK's published value for the network.
 *
 * @param origin - Where the key came from.
 * @returns The phrase to log.
 */
function mpcKeyOrigin(origin: CounterpartyOrigin): string {
  return origin === CounterpartyOrigin.Environment
    ? "MPC_SECP256K1_PUBKEY"
    : "the MPC root public key the SDK publishes for this network";
}

/**
 * Check service reachability and the compiler before wallet preparation.
 *
 * @param env - Deployment configuration.
 * @throws {Error} If a service is unreachable, compact is missing, or `EVM_RPC_URL` is unset.
 */
export async function assertEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
  await assertHttpReachable("indexer", nodeConfig.indexerUrl);
  await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
  await assertCommandAvailable("compact", ["--version"]);
  requireEnv(env, "EVM_RPC_URL");
}

/**
 * Reject an explicit chain ID that differs from the configured RPC.
 *
 * @param env - Deployment configuration.
 * @throws {Error} If the RPC is unreachable or a preset `EVM_CHAIN_ID` mismatches it.
 */
export async function resolveEvmChain(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  let chainId: bigint;
  try {
    chainId = await getEvmChainId(rpcUrl);
  } catch (error) {
    throw new Error(
      `EVM_RPC_URL (${rpcUrl}) is not answering. Check the EVM node.` +
        ` For the local loop it is the \`evm\` docker compose service: \`docker compose up -d\` at the repo root`,
      { cause: error },
    );
  }
  if (env.EVM_CHAIN_ID) {
    if (BigInt(env.EVM_CHAIN_ID) !== chainId) {
      throw new Error(
        `EVM_CHAIN_ID must match the chain EVM_RPC_URL serves (it is sealed into the example's contract at` +
          ` initialise): the RPC reports ${String(chainId)}, found ${env.EVM_CHAIN_ID}`,
      );
    }
    logSkip("resolve EVM chain id", `EVM_CHAIN_ID is set correctly`);
  } else {
    env.EVM_CHAIN_ID = chainId.toString();
  }
}

/**
 * Generate a fakenet root key only when configuration does not identify a deployed MPC.
 *
 * @param env - Deployment configuration.
 * @throws {Error} If a preset public key is malformed, disagrees with the SDK's published
 */
export function ensureMpcRootKey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    logSkip("check/derive MPC root key", "MPC_ROOT_KEY is configured");
    return;
  }
  const preset = findMpcRootPublicKey(env);
  if (preset !== undefined) {
    const { networkId } = getMidnightNodeConfig(env);
    if (isLocalStandaloneNetwork(networkId)) {
      throw new Error(
        `${mpcKeyOrigin(preset.origin)} is set (${preset.value}) without MPC_ROOT_KEY on the local ` +
          `"${networkId}" stack, which no real MPC answers. Unset it so the setup mints a fakenet ` +
          "root key, or set the MPC_ROOT_KEY it derives from.",
      );
    }
    logSkip(
      "check/derive MPC root key",
      `${mpcKeyOrigin(preset.origin)} names a real MPC network (${preset.value}), whose root key this run does not hold`,
    );

    return;
  }
  env.MPC_ROOT_KEY = generateMpcRootKey();
}
const mpcKeys = (env: NodeJS.ProcessEnv) => deriveMpcKeys(requireEnv(env, "MPC_ROOT_KEY"));

/**
 * Reject configuration that contradicts the response key derived for the deployed contract.
 *
 * @param env - Deployment configuration.
 * @param contractAddressEnvVar - The env-var name holding the client
 * @throws {Error} If a pre-set MPC_RESPONSE_KEY disagrees with the derivation.
 */
export function ensureMpcResponseKey(env: NodeJS.ProcessEnv, contractAddressEnvVar: string): void {
  const expected = formatSecp256k1PublicKey(
    deriveMidnightResponseKey(
      requireEnv(env, "MPC_SECP256K1_PUBKEY"),
      requireEnv(env, contractAddressEnvVar),
    ),
  );
  if (env.MPC_RESPONSE_KEY) {
    if (env.MPC_RESPONSE_KEY !== expected) {
      throw new Error(
        `MPC_RESPONSE_KEY should be derived from MPC_ROOT_KEY + ${contractAddressEnvVar}: ` +
          `expected ${expected}, found ${env.MPC_RESPONSE_KEY}`,
      );
    }
    logSkip("check/derive MPC_RESPONSE_KEY public key", `MPC_RESPONSE_KEY is set correctly`);
    return;
  }
  env.MPC_RESPONSE_KEY = expected;
}

/**
 * Keep the configured public key consistent with the selected MPC.
 *
 * @param env - Deployment configuration.
 * @throws {Error} If a preset key mismatches the one derived from `MPC_ROOT_KEY`, is
 */
export function ensureMpcSecp256k1Pubkey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    const derived = normaliseSecp256k1PublicKey(mpcKeys(env).secp256k1CompressedPubkey);
    const supplied = env.MPC_SECP256K1_PUBKEY?.trim();
    if (supplied) {
      const preset = normaliseSecp256k1PublicKey(supplied);

      if (preset !== derived) {
        throw new Error(
          `MPC_SECP256K1_PUBKEY should be derived from MPC_ROOT_KEY: expected ${derived}, found ${preset}`,
        );
      }
      env.MPC_SECP256K1_PUBKEY = derived;
      logSkip(
        "check/derive MPC_SECP256K1_PUBKEY public key",
        `MPC_SECP256K1_PUBKEY is set correctly`,
      );
      return;
    }
    env.MPC_SECP256K1_PUBKEY = derived;

    return;
  }
  const preset = findMpcRootPublicKey(env);
  if (preset === undefined) {
    throw new Error(
      "no MPC to face: MPC_ROOT_KEY and MPC_SECP256K1_PUBKEY are both unset and the SDK publishes " +
        `no MPC root public key for "${getMidnightNodeConfig(env).networkId}" yet. Set ` +
        "MPC_SECP256K1_PUBKEY to the real MPC's root public key (SEC1 hex or NEAR secp256k1:<base58>), " +
        "or MPC_ROOT_KEY to run a fakenet.",
    );
  }
  env.MPC_SECP256K1_PUBKEY = preset.value;
}

/**
 * The caller must verify source-bound cache integrity before opting into prebuilt keys.
 *
 * @param env - Setup environment accumulator.
 * @param keysDir - Managed keys directory relative to the repository root.
 * @returns Whether verified prebuilt keys are available.
 */
function trustsPrebuiltZkKeys(env: NodeJS.ProcessEnv, keysDir: string): boolean {
  if (env.TRUST_PREBUILT_ZK_KEYS !== "1") {
    return false;
  }
  try {
    return readdirSync(join(REPO_ROOT, keysDir)).some((file) => file.endsWith(".prover"));
  } catch {
    return false;
  }
}

/** What {@link compileContractZk} compiles and how it decides to skip. */
export interface CompileContractZkOptions {
  /** Env var whose deployed address skips compilation. */
  addressEnvVar: string;
  /** The root package script that runs the zk compile (e.g. `compile:erc20-vault:zk`). */
  rootScript: string;
  /** The contract's managed keys directory, relative to the repo root (for the CI cache check). */
  keysDir: string;
}

/**
 * Accept cached keys only under explicit trusted-cache configuration or a recorded deployment.
 *
 * @param env - Deployment configuration.
 * @param options - Which contract to compile and how to decide to skip.
 * @throws {Error} If the compile script fails or times out.
 */
export async function compileContractZk(
  env: NodeJS.ProcessEnv,
  options: CompileContractZkOptions,
): Promise<void> {
  const presetAddress = env[options.addressEnvVar];
  if (presetAddress) {
    logSkip(options.rootScript, `${options.addressEnvVar} is set (${presetAddress})`);
    return;
  }
  if (trustsPrebuiltZkKeys(env, options.keysDir)) {
    logSkip(
      options.rootScript,
      "TRUST_PREBUILT_ZK_KEYS=1 and prover keys are present (restored from a cache keyed on the contract sources)",
    );
    return;
  }
  await runRootScript(options.rootScript, env, 14 * MINUTE);
}

/**
 * Translate the local node dust-proof rejection into an actionable setup failure.
 *
 * @param what - Step label for the error message.
 * @param action - The fee-paying call.
 * @returns Whatever `action` resolves to.
 * @throws {Error} The node's `Custom error: 170` rejection (`InvalidDustSpendProof`,
 */
export async function explainDustSpendRejection<T>(
  what: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = String(error);
    if (message.includes("Custom error: 170") || message.includes("InvalidDustSpendProof")) {
      throw new Error(
        `${what}: node rejected the dust spend (error 170 = InvalidDustSpendProof). ` +
          "The local chain has diverged from the wallet's dust state: reset the stack " +
          "(docker compose down and up, then redeploy) before rerunning. " +
          `Original error: ${message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Deploy only when the selected network and configuration provide no Signet address.
 *
 * @param env - Deployment configuration.
 * @param wallets - The pipeline's registry, holding the deployer wallet the funding step synced.
 * @throws {Error} If a preset address disagrees with the SDK's published one, or the deploy fails.
 */
export async function deploySignetContractStep(
  env: NodeJS.ProcessEnv,
  wallets: WalletRegistry,
): Promise<void> {
  const { networkId } = getMidnightNodeConfig(env);
  const found = findSignetContractAddress(env);
  if (found?.origin === CounterpartyOrigin.Environment) {
    env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = found.value;
    logSkip("deploy signet contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${found.value})`);
    return;
  }
  if (found !== undefined) {
    env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = found.value;
    logSkip(
      "deploy signet contract",
      `the SDK publishes the "${networkId}" signet singleton at ${found.value}`,
    );

    return;
  }
  const { contractAddress } = await explainDustSpendRejection("deploy signet contract", () =>
    deploySignetContract(env, wallets),
  );
  env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
}

/** The env keys docker compose interpolates into the fakenet service. */
const FAKENET_HANDOFF_KEYS = ["MPC_ROOT_KEY", "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"] as const;

/** A changed persisted handoff requires responder recreation to clear its private state. */
let fakenetHandoffAppended = false;

/**
 * Refuse conflicting saved values before passing configuration to Compose.
 *
 * @param env - Deployment configuration (holds the run's values).
 * @throws {Error} If a hand-off key in `.env` conflicts with the run's value.
 */
export function persistFakenetHandoffToDotEnv(env: NodeJS.ProcessEnv): void {
  fakenetHandoffAppended = false;
  if (mpcKind(env) === MpcKind.Real) {
    logSkip("persist fakenet hand-off to .env", "a real MPC answers this run: nothing to hand off");
    return;
  }
  if (env.FAKENET_MANAGED === "0") {
    logSkip(
      "persist fakenet hand-off to .env",
      "FAKENET_MANAGED=0 selects externally managed responder configuration",
    );
    return;
  }
  const fileEnv = loadRepoDotEnv();
  const toAppend: Record<string, string> = {};
  for (const key of FAKENET_HANDOFF_KEYS) {
    const runValue = requireEnv(env, key);
    const fileValue = fileEnv[key];
    if (fileValue === runValue) {
      continue;
    }
    if (fileValue !== undefined) {
      throw new Error(
        `${key} conflicts with its saved .env value.` +
          ` docker compose reads .env, so the fakenet responder would start against the stale value.` +
          ` Reconcile the two (usually: update .env and unset the shell override), then rerun.`,
      );
    }
    toAppend[key] = runValue;
  }
  if (Object.keys(toAppend).length === 0) {
    logSkip(
      "persist fakenet hand-off to .env",
      `${FAKENET_HANDOFF_KEYS.join(" and ")} are already in .env`,
    );
    return;
  }
  appendRepoDotEnv(
    toAppend,
    `generated setup configuration (${new Date().toISOString()}) for the fakenet responder`,
  );
  fakenetHandoffAppended = true;
}

/**
 * Start only the responder. Other services must already be reachable, and changes to persisted keys require responder recreation.
 *
 * @param env - Deployment configuration (passed to docker compose, whose
 * @throws {Error} If docker compose fails or the container is not `running` after `up`.
 */
export async function startFakenetResponder(env: NodeJS.ProcessEnv): Promise<void> {
  if (mpcKind(env) === MpcKind.Real) {
    logSkip("start fakenet responder", "a real MPC answers this run: no responder to start");
    return;
  }
  if (env.FAKENET_MANAGED === "0") {
    logSkip(
      "start fakenet responder",
      "FAKENET_MANAGED=0 requires an externally started responder: `docker compose --profile fakenet up -d --force-recreate fakenet`," +
        " or `yarn response` in a solana-signet-program checkout (responder development)",
    );
    return;
  }
  await assertCommandAvailable("docker", ["compose", "version"]);

  const args = [
    "compose",
    "--profile",
    "fakenet",
    "up",
    "-d",
    "--no-deps",
    ...(fakenetHandoffAppended ? ["--force-recreate"] : []),
    "fakenet",
  ];

  await runCommand("docker", args, env, 10 * MINUTE);
  const status = (
    await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", "fakenet-responder"],
      env,
      MINUTE,
    )
  ).trim();
  if (status !== "running") {
    throw new Error(
      `fakenet-responder container is "${status}", expected "running". Check \`docker logs fakenet-responder\``,
    );
  }
}
