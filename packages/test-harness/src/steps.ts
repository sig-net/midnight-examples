// The GENERIC setup steps every example's pipeline composes: environment
// check → wallet seed resolution + root funding (wallets.ts) → EVM chain
// resolution → MPC key derivation → singleton signet deploy → fakenet
// responder hand-off → MPC hand-off printout. EVM token and account funding
// is example-specific and lives in the example itself.
// Each step keeps its skip-if-env-var-set semantics (presence of the
// canonical env var doubles as the skip signal) and mutates the shared env
// accumulator. Steps that touch an example's own artifacts (its requester
// contract deploy, its derived EVM addresses) take those specifics as
// parameters or live in the example itself. Run by an example's globalSetup
// via {@link file://./setup-pipeline.ts runSetupPipeline} in vitest's main
// process, so no `vitest` imports here.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  type DeployedNetwork,
  deriveMidnightResponseKey,
  formatSecp256k1PublicKey,
  getMpcRootPublicKey,
  getSignetContractAddress,
  normaliseSecp256k1PublicKey,
  stripHexPrefix,
} from "@sig-net/midnight";
import {
  deploySignetContract,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  MidnightNetwork,
  type NetworkId,
} from "@sig-net/midnight-contract-deploy";
import { loadRepoDotEnv, REPO_ROOT } from "@sig-net/midnight-examples-lib";

import { requireEnv } from "./e2e-env.ts";
import { appendRepoDotEnv } from "./env-file.ts";
import { getEvmChainId } from "./evm.ts";
import { runCommand, runRootScript } from "./exec.ts";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";
import { MpcKind, mpcKind } from "./mpc-kind.ts";
import { banner, logSkip } from "./output.ts";
import { assertCommandAvailable, assertHttpReachable } from "./preflight.ts";

const MINUTE = 60_000;

/**
 * Assert the environment is workable before anything spends time or money:
 * the Midnight stack answers, the compact compiler is on PATH, and
 * `EVM_RPC_URL` is set. The wallets in play are resolved (and printed) by
 * the wallet steps in wallets.ts, which run right after this.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a service is unreachable, compact is missing, or `EVM_RPC_URL` is unset.
 */
export async function assertEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
  await assertHttpReachable("indexer", nodeConfig.indexerUrl);
  await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
  await assertCommandAvailable("compact", ["--version"]);
  requireEnv(env, "EVM_RPC_URL");
  console.log(`targeting the ${nodeConfig.networkId} network at ${nodeConfig.nodeUrl}`);
}

/**
 * Resolve `EVM_CHAIN_ID` from `EVM_RPC_URL` (or verify a preset value
 * against what the RPC reports — loud failure on mismatch, since examples
 * seal the chain id into their contracts at initialise).
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If the RPC is unreachable or a preset `EVM_CHAIN_ID` mismatches it.
 */
export async function resolveEvmChain(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  let chainId: bigint;
  try {
    chainId = await getEvmChainId(rpcUrl);
  } catch (error) {
    throw new Error(
      `EVM_RPC_URL (${rpcUrl}) is not answering — is the EVM node up?` +
        ` For the local loop it is the \`evm\` docker compose service: \`docker compose up -d\` at the repo root`,
      { cause: error },
    );
  }
  if (env.EVM_CHAIN_ID) {
    console.log(`Found EVM_CHAIN_ID in the environment as ${env.EVM_CHAIN_ID}`);
    if (BigInt(env.EVM_CHAIN_ID) !== chainId) {
      throw new Error(
        `EVM_CHAIN_ID must match the chain EVM_RPC_URL serves (it is sealed into the example's contract at` +
          ` initialise): the RPC reports ${String(chainId)}, found ${env.EVM_CHAIN_ID}`,
      );
    }
    logSkip("resolve EVM chain id", `EVM_CHAIN_ID is set correctly`);
  } else {
    env.EVM_CHAIN_ID = chainId.toString();
    console.log(`resolved EVM_CHAIN_ID=${env.EVM_CHAIN_ID} from EVM_RPC_URL`);
    console.log(
      ` ➜ sealed into the example's contract at initialise as CAIP-2 eip155:${env.EVM_CHAIN_ID}`,
    );
    console.log(` ➜ 💡 Set as EVM_CHAIN_ID in the environment to pin it explicitly`);
  }
}

// The deployed networks the SDK publishes per-network counterparty values
// for (the MPC root public key, the signet singleton's address). The local
// standalone stack has neither: each run mints its own.
const DEPLOYED_NETWORKS: readonly DeployedNetwork[] = [
  MidnightNetwork.Stagenet,
  MidnightNetwork.Preview,
  MidnightNetwork.Preprod,
  MidnightNetwork.Mainnet,
];

/**
 * Narrow a resolved network id to a network the SDK may publish values for.
 *
 * @param networkId - The network the run resolved.
 * @returns The same id as a {@link DeployedNetwork}, or undefined for the local stack.
 */
function deployedNetwork(networkId: NetworkId): DeployedNetwork | undefined {
  const id: string = networkId;
  return DEPLOYED_NETWORKS.find((network) => {
    const candidate: string = network;
    return candidate === id;
  });
}

/**
 * The SDK's published value for a deployed network, or undefined when the
 * network is the local stack or the SDK holds no value for it yet (the SDK
 * throws for an unpublished entry, and "not published yet" is a normal state
 * for a young network, not a failure).
 *
 * @param networkId - The network the run resolved.
 * @param lookup - The SDK lookup (`getMpcRootPublicKey`, `getSignetContractAddress`).
 * @returns The published value, or undefined.
 */
function publishedForNetwork(
  networkId: NetworkId,
  lookup: (network: DeployedNetwork) => string,
): string | undefined {
  const network = deployedNetwork(networkId);
  if (network === undefined) return undefined;
  try {
    return lookup(network);
  } catch {
    return undefined;
  }
}

/** Where a run's MPC root public key came from, when no root key is held. */
enum MpcPublicKeyOrigin {
  Environment = "MPC_SECP256K1_PUBKEY",
  Sdk = "the MPC root public key the SDK publishes for this network",
}

/** An MPC root public key the run holds without holding the root key. */
interface PresetMpcPublicKey {
  /** The key, canonicalised (`0x04…` uncompressed SEC1 hex). */
  readonly value: string;
  /** Which source supplied it. */
  readonly origin: MpcPublicKeyOrigin;
}

/**
 * The MPC root public key a run is handed rather than deriving: the
 * environment's `MPC_SECP256K1_PUBKEY` (any spelling
 * {@link normaliseSecp256k1PublicKey} accepts) or, failing that, the key the
 * SDK publishes for a deployed network. Both present and different is a
 * misconfiguration worth stopping on, since the key is sealed into every
 * derived account.
 *
 * @param env - The suite's env accumulator.
 * @returns The preset key and its origin, or undefined when nothing supplies one.
 * @throws {Error} If `MPC_SECP256K1_PUBKEY` is malformed or disagrees with the SDK's published key.
 */
function presetMpcSecp256k1Pubkey(env: NodeJS.ProcessEnv): PresetMpcPublicKey | undefined {
  const { networkId } = getMidnightNodeConfig(env);
  const supplied = env.MPC_SECP256K1_PUBKEY?.trim();
  const fromEnvironment = supplied ? normaliseSecp256k1PublicKey(supplied) : undefined;
  const publishedRaw = publishedForNetwork(networkId, getMpcRootPublicKey);
  const published =
    publishedRaw === undefined ? undefined : normaliseSecp256k1PublicKey(publishedRaw);
  const disagree =
    fromEnvironment !== undefined && published !== undefined && fromEnvironment !== published;
  if (disagree) {
    throw new Error(
      `MPC_SECP256K1_PUBKEY (${fromEnvironment}) disagrees with the MPC root public key the SDK ` +
        `publishes for "${networkId}" (${published}). One of the two is wrong, and the key is ` +
        "sealed into every derived account: reconcile them before running.",
    );
  }
  if (fromEnvironment !== undefined) {
    return { value: fromEnvironment, origin: MpcPublicKeyOrigin.Environment };
  }
  if (published !== undefined) {
    return { value: published, origin: MpcPublicKeyOrigin.Sdk };
  }
  return undefined;
}

/**
 * Ensure the run knows which MPC it faces: a fakenet, whose `MPC_ROOT_KEY`
 * this run holds (kept when set, generated when nothing names an MPC), or a
 * real MPC network, named by a preset root PUBLIC key (`MPC_SECP256K1_PUBKEY`,
 * or the SDK's published key for a deployed network) whose root key nobody
 * here holds. A preset public key therefore never generates a root key: a
 * random root key beside a real MPC's public key could only ever mismatch.
 * The local standalone stack has no real MPC, so a preset public key without
 * a root key there is refused rather than left to fail at the first poll.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset public key is malformed, disagrees with the SDK's published
 *   key, or names a real MPC on the local standalone stack.
 */
export function ensureMpcRootKey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    logSkip("check/derive MPC root key", `MPC_ROOT_KEY is set as ${env.MPC_ROOT_KEY}`);
    return;
  }
  const preset = presetMpcSecp256k1Pubkey(env);
  if (preset !== undefined) {
    const { networkId } = getMidnightNodeConfig(env);
    if (isLocalStandaloneNetwork(networkId)) {
      throw new Error(
        `${preset.origin} is set (${preset.value}) without MPC_ROOT_KEY on the local ` +
          `"${networkId}" stack, which no real MPC answers. Unset it so the setup mints a fakenet ` +
          "root key, or set the MPC_ROOT_KEY it derives from.",
      );
    }
    logSkip(
      "check/derive MPC root key",
      `${preset.origin} names a real MPC network (${preset.value}), whose root key this run does not hold`,
    );
    console.log(
      ` ➜ no fakenet responder can serve that key: the real MPC answers the signet singleton`,
    );
    return;
  }
  env.MPC_ROOT_KEY = generateMpcRootKey();
  console.log(`generated a fresh MPC_ROOT_KEY=${env.MPC_ROOT_KEY}`);
  console.log(` ➜ seeds MPC key generation`);
  console.log(` ➜ 💡 Set as MPC_ROOT_KEY in the environment to skip this step on the next run`);
  console.log("(printed again in the MPC server configuration step)");
}

// Derive MPC keys for setting or checking public keys. Must be called INSIDE
// the steps below — after ensureMpcRootKey has a chance to generate
// MPC_ROOT_KEY.
const mpcKeys = (env: NodeJS.ProcessEnv) => deriveMpcKeys(requireEnv(env, "MPC_ROOT_KEY"));

/**
 * Derive (or check) `MPC_RESPONSE_KEY` for a deployed client contract:
 * `MPC_RESPONSE_KEY = f(MPC root key, client contract address, "midnight
 * response key")`, the sender-scoped derivation the real MPC uses for
 * respond-bidirectional signing. The key depends on the client contract's
 * address, so this step MUST run after the client contract deploy; the
 * example's initialise flow then pins the key on-chain via the contract's
 * one-shot initialise circuit. The fakenet responder derives the same key
 * per request from its MPC_ROOT_KEY + the request's sender, so nothing
 * extra is handed off.
 *
 * @param env - The suite's env accumulator.
 * @param contractAddressEnvVar - The env-var name holding the client
 *   contract's deployed address (e.g. the example's vault contract).
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
    console.log(`Found MPC_RESPONSE_KEY in the environment as ${env.MPC_RESPONSE_KEY}`);
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
  console.log(`derived a fresh MPC_RESPONSE_KEY=${env.MPC_RESPONSE_KEY}`);
  console.log(
    ` ➜ the MPC's respond-bidirectional key for the client contract; the initialise flow pins it on-chain`,
  );
  console.log(` ➜ 💡 Set as MPC_RESPONSE_KEY in the environment to skip this step on the next run`);
}

/**
 * Ensure `MPC_SECP256K1_PUBKEY` holds the MPC's root public key in canonical
 * form (`0x04…` uncompressed SEC1 hex, what every derivation reads). With
 * `MPC_ROOT_KEY` held (a fakenet) the key is derived from it and any preset
 * must agree. Without one the preset itself (the environment's, in any
 * accepted spelling, or the SDK's published key) is canonicalised into the
 * accumulator.
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset key mismatches the one derived from `MPC_ROOT_KEY`, is
 *   malformed, or nothing at all supplies a key.
 */
export function ensureMpcSecp256k1Pubkey(env: NodeJS.ProcessEnv): void {
  const preset = presetMpcSecp256k1Pubkey(env);
  if (env.MPC_ROOT_KEY) {
    const derived = normaliseSecp256k1PublicKey(mpcKeys(env).secp256k1CompressedPubkey);
    if (preset !== undefined) {
      console.log(`Found ${preset.origin} as ${preset.value}`);
      if (preset.value !== derived) {
        throw new Error(
          `MPC_SECP256K1_PUBKEY should be derived from MPC_ROOT_KEY: expected ${derived}, found ${preset.value}`,
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
    console.log(`generated a fresh MPC_SECP256K1_PUBKEY=${env.MPC_SECP256K1_PUBKEY}`);
    console.log(` ➜ used by contracts to validate signatures`);
    console.log(
      ` ➜ 💡 Set as MPC_SECP256K1_PUBKEY in the environment to skip this step on the next run`,
    );
    return;
  }
  if (preset === undefined) {
    throw new Error(
      "no MPC to face: MPC_ROOT_KEY and MPC_SECP256K1_PUBKEY are both unset and the SDK publishes " +
        `no MPC root public key for "${getMidnightNodeConfig(env).networkId}" yet. Set ` +
        "MPC_SECP256K1_PUBKEY to the real MPC's root public key (SEC1 hex or NEAR secp256k1:<base58>), " +
        "or MPC_ROOT_KEY to run a fakenet.",
    );
  }
  env.MPC_SECP256K1_PUBKEY = preset.value;
  console.log(`using ${preset.origin}: MPC_SECP256K1_PUBKEY=${preset.value}`);
  console.log(` ➜ canonicalised to uncompressed SEC1 hex: every derived account starts from it`);
}

/**
 * True when the CI zk-key cache contract is in force: `TRUST_PREBUILT_ZK_KEYS=1`
 * AND the given managed keys directory already holds prover keys. Local runs
 * never set the variable — key PRESENCE alone is not FRESHNESS (a circuit
 * edit leaves stale keys behind; locally the contract-address env vars are
 * the skip signal instead). Only a cache keyed on the contract sources can
 * assert freshness, so trusting prebuilt keys is an explicit opt-in by the
 * environment that restored them (see the CI workflow).
 *
 * @param env - The suite's env accumulator.
 * @param keysDir - The managed keys directory, relative to the repo root.
 * @returns Whether the zk compile step may be skipped.
 */
function trustsPrebuiltZkKeys(env: NodeJS.ProcessEnv, keysDir: string): boolean {
  if (env.TRUST_PREBUILT_ZK_KEYS !== "1") {
    return false;
  }
  try {
    return readdirSync(join(REPO_ROOT, keysDir)).some((file) => file.endsWith(".prover"));
  } catch {
    return false; // cache miss — the directory does not exist yet
  }
}

/** What {@link compileContractZk} compiles and how it decides to skip. */
export interface CompileContractZkOptions {
  /** Env var holding the contract's deployed address — set means skip (no deploy this run). */
  addressEnvVar: string;
  /** The root package script that runs the zk compile (e.g. `compile:erc20-vault:zk`). */
  rootScript: string;
  /** The contract's managed keys directory, relative to the repo root (for the CI cache check). */
  keysDir: string;
}

/**
 * Compile a contract with proving keys (the slow, ~10-minute zk compile),
 * skipping when the contract is already deployed (its address env var is
 * set) or when CI restored trusted prebuilt keys.
 *
 * @param env - The suite's env accumulator.
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
 * Run a fee-paying call (a deploy, a root-to-child funding transfer) and
 * translate the one opaque node rejection a local stack produces. Waiting
 * for DUST is not this function's job: the deploy plumbing retries the
 * balancing step itself while dust generates, and a wallet with nothing to
 * generate from fails fast in `ensureFeeReady` with a funding hint.
 *
 * @param what - Step label for the error message.
 * @param action - The fee-paying call.
 * @returns Whatever `action` resolves to.
 * @throws {Error} The node's `Custom error: 170` rejection (`InvalidDustSpendProof`,
 *   which the node reports as `1010: Invalid Transaction: Custom error: 170`)
 *   wrapped with the stack-reset hint, as the raw message is opaque. Any
 *   other error passes through unchanged.
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
 * Deploy the central signet contract (the Signature Network singleton every
 * example's requester contract notifies), unless one is already named:
 * `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` when set, else the singleton the SDK
 * publishes for a deployed network (which the real MPC listens to, so a
 * second singleton there would never be answered). The example's own
 * requester contract deploy is the example's step — it runs AFTER this one
 * (requesters seal the signet address at deploy time).
 *
 * @param env - The suite's env accumulator.
 * @throws {Error} If a preset address disagrees with the SDK's published one, or the deploy fails.
 */
export async function deploySignetContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  const { networkId } = getMidnightNodeConfig(env);
  const preset = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  const published = publishedForNetwork(networkId, getSignetContractAddress);
  if (
    preset &&
    published !== undefined &&
    stripHexPrefix(preset).toLowerCase() !== stripHexPrefix(published).toLowerCase()
  ) {
    throw new Error(
      `MIDNIGHT_SIGNET_CONTRACT_ADDRESS (${preset}) disagrees with the signet singleton the SDK ` +
        `publishes for "${networkId}" (${published}). The real MPC answers only the published one, ` +
        "and requesters seal the address at deploy: reconcile them before running.",
    );
  }
  if (preset) {
    logSkip("deploy signet contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${preset})`);
    return;
  }
  if (published !== undefined) {
    env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = published;
    logSkip(
      "deploy signet contract",
      `the SDK publishes the "${networkId}" signet singleton at ${published}`,
    );
    console.log(` ➜ the real MPC listens to that singleton: requesters deployed here notify it`);
    return;
  }
  const { contractAddress } = await explainDustSpendRejection("deploy signet contract", () =>
    deploySignetContract(env),
  );
  env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(
    ` ➜ the Signet singleton on Midnight: append-only logs of signature requests and MPC responses`,
  );
  console.log(
    ` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip the deploy on the next run`,
  );
}

// The fakenet responder hand-off, automated. docker compose interpolates the
// fakenet service's environment from the repo-root .env, so the responder can
// only start once MPC_ROOT_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS are IN
// THAT FILE — the two steps below persist them (append-only) and start the
// container, right after the signet deploy so the responder boots and syncs
// while the (long) example zk compile runs. Both steps skip when the run
// faces a real MPC (see mpcKind: no root key to hand off), and under
// FAKENET_MANAGED=0, which says you run the responder yourself (e.g.
// `yarn response` in a solana-signet-program checkout for responder
// development).

/** The env keys docker compose interpolates into the fakenet service — the hand-off payload. */
const FAKENET_HANDOFF_KEYS = ["MPC_ROOT_KEY", "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"] as const;

/**
 * Whether {@link persistFakenetHandoffToDotEnv} appended hand-off values to
 * `.env` THIS run. Read by {@link startFakenetResponder} to decide between a
 * plain `up -d` (values were already in the file — a running responder is
 * already correct) and `--force-recreate` (values newly landed — the
 * responder must re-read `.env` and reset its private state).
 */
let fakenetHandoffAppended = false;

/**
 * Persist the fakenet hand-off values to the repo-root `.env`, append-only.
 * Each key is checked against the FILE (not the process env): already there
 * with the run's value → nothing to do; absent → appended under a provenance
 * comment; present with a DIFFERENT value → hard error, because docker
 * compose reads the file and would start the responder against the stale
 * value while this run uses another.
 *
 * @param env - The suite's env accumulator (holds the run's values).
 * @throws {Error} If a hand-off key in `.env` conflicts with the run's value.
 */
export function persistFakenetHandoffToDotEnv(env: NodeJS.ProcessEnv): void {
  if (mpcKind(env) === MpcKind.Real) {
    logSkip("persist fakenet hand-off to .env", "a real MPC answers this run: nothing to hand off");
    return;
  }
  if (env.FAKENET_MANAGED === "0") {
    logSkip(
      "persist fakenet hand-off to .env",
      "FAKENET_MANAGED=0 — you manage the responder and its config yourself",
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
        `${key} conflicts: this run uses ${runValue} (from your shell environment) but .env holds ${fileValue}.` +
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
    `appended by the test-harness setup (${new Date().toISOString()}) — fakenet responder hand-off`,
  );
  fakenetHandoffAppended = true;
  for (const [key, value] of Object.entries(toAppend)) {
    console.log(`appended ${key}=${value} to .env`);
  }
  console.log(` ➜ docker compose interpolates the fakenet service's environment from .env`);
  console.log(` ➜ append-only: existing .env lines are never modified`);
}

/**
 * Start (or recreate) the fakenet responder compose service. Recreates the
 * container only when {@link persistFakenetHandoffToDotEnv} appended values
 * this run — a recreate re-reads `.env` and resets the responder's private
 * state, which is required after a fresh key/deploy and disruptive otherwise.
 * Container readiness here means `running`; hard readiness is confirmed by
 * the first signature poll in the flows (poll loops tolerate startup lag).
 *
 * @param env - The suite's env accumulator (passed to docker compose, whose
 *   interpolation lets process env win over `.env` — same values by the time
 *   this runs, so the two sources agree).
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
      "FAKENET_MANAGED=0 — start it yourself: `docker compose --profile fakenet up -d --force-recreate fakenet`," +
        " or `yarn response` in a solana-signet-program checkout (responder development)",
    );
    return;
  }
  await assertCommandAvailable("docker", ["compose", "version"]);
  console.log(
    fakenetHandoffAppended
      ? "hand-off values newly landed in .env — recreating the responder so it re-reads .env and resets its private state"
      : "hand-off values were already in .env — plain up: a running responder is left untouched",
  );
  const args = [
    "compose",
    "--profile",
    "fakenet",
    "up",
    "-d",
    ...(fakenetHandoffAppended ? ["--force-recreate"] : []),
    "fakenet",
  ];
  console.log(`$ docker ${args.join(" ")}   (cwd: repo root)`);
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
      `fakenet-responder container is "${status}", expected "running" — check \`docker logs fakenet-responder\``,
    );
  }
  console.log("fakenet-responder container is running");
  console.log(" ➜ watch it: `docker logs -f fakenet-responder` — healthy startup prints");
  console.log('   "MidnightMonitor: polling signet contract events at <signet address>"');
}

/**
 * Print the MPC configuration banner: which MPC the run faces (a fakenet
 * responder, with its root key + signet address hand-off and how it was or
 * must be started, or a real MPC network named by its root public key), and
 * the minimal `.env` block that lets the next run skip every derivation.
 *
 * @param env - The suite's env accumulator.
 * @param pipelineKeys - The example's pipeline env-var names, in derivation
 *   order — printed as the ready-to-paste `.env` block.
 */
export function printMpcServerConfig(
  env: NodeJS.ProcessEnv,
  pipelineKeys: readonly string[],
): void {
  const managed = env.FAKENET_MANAGED !== "0";
  const signetContractAddress = requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const minimalEnvBlock = [
    "",
    "Minimal .env block for THIS suite:",
    "",
    ...pipelineKeys.map((key) => `  ${key}=${env[key] ?? ""}`),
    `  EVM_RPC_URL=${env.EVM_RPC_URL ?? ""}`,
  ];
  if (mpcKind(env) === MpcKind.Real) {
    banner([
      "MPC configuration: a real MPC network answers this run.",
      "",
      `  MPC_SECP256K1_PUBKEY=${requireEnv(env, "MPC_SECP256K1_PUBKEY")}`,
      `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${signetContractAddress}`,
      "  # 💡 The MPC DISCOVERS requesters by polling this signet contract's",
      "  #    emitted notification events, and its root key is not held here.",
      ...minimalEnvBlock,
    ]);
    return;
  }
  banner([
    "MPC (fakenet) responder configuration:",
    "",
    `  MPC_ROOT_KEY=${requireEnv(env, "MPC_ROOT_KEY")}`,
    `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${signetContractAddress}`,
    "  # 💡 The responder DISCOVERS requesters by polling this signet",
    "  #    contract's emitted notification events — no requester contract list needed.",
    "",
    ...(managed
      ? [
          "The setup already persisted these to .env (append-only) and started",
          "the responder container — see the two hand-off steps above. Watch it",
          "with `docker logs -f fakenet-responder`; recreate it manually with",
          "`docker compose --profile fakenet up -d --force-recreate fakenet`.",
          "(Set FAKENET_MANAGED=0 to run the responder yourself, e.g.",
          "`yarn response` in a checkout of sig-net/solana-signet-program.)",
        ]
      : [
          "FAKENET_MANAGED=0 — make sure those two are in THIS repo's .env",
          "(docker compose reads it), then START THE RESPONDER container:",
          "",
          "  docker compose --profile fakenet up -d --force-recreate fakenet",
          "",
          "(--force-recreate re-reads .env and resets the responder's private state",
          "after a redeploy; watch it with `docker logs -f fakenet-responder`.",
          "Fallback for responder development: `yarn response` in a checkout of",
          "github.com/sig-net/solana-signet-program.) The e2e flows need it running.",
        ]),
    ...minimalEnvBlock,
  ]);
}
