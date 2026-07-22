// The GENERIC setup steps every example's pipeline composes: environment
// check → wallet seed resolution + root funding (wallets.ts) → EVM chain
// resolution + test-token deploy (example-supplied) → MPC key derivation →
// singleton signet deploy → fakenet responder hand-off → local-EVM funding →
// MPC hand-off printout.
// Each step keeps its skip-if-env-var-set semantics (presence of the
// canonical env var doubles as the skip signal) and mutates the shared env
// accumulator. Steps that touch an example's own artifacts (its requester
// contract deploy, its derived EVM addresses, its test token) take those
// specifics as parameters or live in the example itself. Run by an example's
// globalSetup via {@link file://./setup-pipeline.ts runSetupPipeline} in
// vitest's main process, so no `vitest` imports here.

import { getMidnightNodeConfig } from "@midnight-examples/lib";
import { deriveMidnightResponseKey, formatSecp256k1PublicKey } from "@sig-net/midnight";
import { deploySignetContract } from "@sig-net/midnight-contract-deploy";
import { formatEther, formatUnits } from "ethers";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "./e2e-env.ts";
import { appendRepoDotEnv, loadRepoDotEnv } from "./env-file.ts";
import { getDeployedCode, getEvmChainId } from "./evm.ts";
import { REPO_ROOT, runCommand, runRootScript } from "./exec.ts";
import { isLocalEvmChain, topUpLocalAccount } from "./local-evm.ts";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";
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
 * @throws If a service is unreachable, compact is missing, or `EVM_RPC_URL` is unset.
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
 * seal the chain id into their contracts at initialize).
 *
 * @param env - The suite's env accumulator.
 * @throws If the RPC is unreachable or a preset `EVM_CHAIN_ID` mismatches it.
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
          ` initialize): the RPC reports ${chainId}, found ${env.EVM_CHAIN_ID}`,
      );
    }
    logSkip("resolve EVM chain id", `EVM_CHAIN_ID is set correctly`);
  } else {
    env.EVM_CHAIN_ID = chainId.toString();
    console.log(`resolved EVM_CHAIN_ID=${env.EVM_CHAIN_ID} from EVM_RPC_URL`);
    console.log(` ➜ sealed into the example's contract at initialize as CAIP-2 eip155:${env.EVM_CHAIN_ID}`);
    console.log(` ➜ 💡 Set as EVM_CHAIN_ID in the environment to pin it explicitly`);
  }
}

/**
 * Ensure `ERC20_ADDRESS` points at a live token: skip when the address has
 * code ON CHAIN (env presence alone is not enough — a kept address can
 * outlive a wiped local chain); otherwise deploy a fresh token through the
 * example-supplied `deployErc20` (only ever on the local dev chain — any
 * other chain demands an explicit, live `ERC20_ADDRESS`).
 *
 * @param env - The suite's env accumulator.
 * @param deployErc20 - The example's compile-and-deploy of its own test
 *   token; returns the deployed address. Only invoked on the local dev chain.
 * @throws If the chain is not the local dev chain and `ERC20_ADDRESS` is
 *   unset or has no code.
 */
export async function ensureErc20Deployed(
  env: NodeJS.ProcessEnv,
  deployErc20: (env: NodeJS.ProcessEnv) => Promise<string>,
): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const chainId = BigInt(requireEnv(env, "EVM_CHAIN_ID"));
  const local = isLocalEvmChain(chainId);
  if (env.ERC20_ADDRESS) {
    const code = await getDeployedCode(rpcUrl, env.ERC20_ADDRESS);
    if (code !== "0x") {
      logSkip("check/deploy ERC20 token", `ERC20_ADDRESS (${env.ERC20_ADDRESS}) has code on chain ${chainId}`);
      return;
    }
    if (!local) {
      throw new Error(
        `ERC20_ADDRESS (${env.ERC20_ADDRESS}) has no code on chain ${chainId} — wrong address, or wrong EVM_RPC_URL?`,
      );
    }
    console.log(`ERC20_ADDRESS (${env.ERC20_ADDRESS}) has no code — the local chain was wiped; redeploying`);
  } else if (!local) {
    throw new Error(
      `ERC20_ADDRESS is not set and chain ${chainId} is not the local dev chain — set the token to use in the environment`,
    );
  }
  env.ERC20_ADDRESS = await deployErc20(env);
  console.log(`deployed a fresh test ERC20 as ERC20_ADDRESS=${env.ERC20_ADDRESS}`);
  console.log(` ➜ the token the example's flows move; open mint funds the derived accounts`);
  console.log(` ➜ 💡 Set as ERC20_ADDRESS in the environment to pin it for the next run`);
}

/**
 * Ensure `MPC_ROOT_KEY` is set, generating a fresh random key when absent.
 *
 * @param env - The suite's env accumulator.
 */
export function ensureMpcRootKey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    logSkip("check/derive MPC root key", `MPC_ROOT_KEY is set as ${env.MPC_ROOT_KEY}`);
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
 * example's initialize flow then pins the key on-chain via the contract's
 * one-shot initialize circuit. The fakenet responder derives the same key
 * per request from its MPC_ROOT_KEY + the request's sender, so nothing
 * extra is handed off.
 *
 * @param env - The suite's env accumulator.
 * @param contractAddressEnvVar - The env-var name holding the client
 *   contract's deployed address (e.g. the example's vault contract).
 * @throws If a pre-set MPC_RESPONSE_KEY disagrees with the derivation.
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
  console.log(` ➜ the MPC's respond-bidirectional key for the client contract; the initialize flow pins it on-chain`);
  console.log(` ➜ 💡 Set as MPC_RESPONSE_KEY in the environment to skip this step on the next run`);
}

/**
 * Ensure `MPC_SECP256K1_PUBKEY` matches the key derived from `MPC_ROOT_KEY`,
 * deriving it when absent.
 *
 * @param env - The suite's env accumulator.
 * @throws If a preset `MPC_SECP256K1_PUBKEY` mismatches the derived key.
 */
export function ensureMpcSecp256k1Pubkey(env: NodeJS.ProcessEnv): void {
  const expectedSECP256k1CompressedPubkey = mpcKeys(env).secp256k1CompressedPubkey;
  if (env.MPC_SECP256K1_PUBKEY) {
    console.log(`Found MPC_SECP256K1_PUBKEY in the environment as ${env.MPC_SECP256K1_PUBKEY}`);
    if (env.MPC_SECP256K1_PUBKEY !== expectedSECP256k1CompressedPubkey) {
      throw new Error(
        `MPC_SECP256K1_PUBKEY should be derived from MPC_ROOT_KEY: expected ${expectedSECP256k1CompressedPubkey}, found ${env.MPC_SECP256K1_PUBKEY}`,
      );
    }
    logSkip("check/derive MPC_SECP256K1_PUBKEY public key", `MPC_SECP256K1_PUBKEY is set correctly`);
    return;
  }
  env.MPC_SECP256K1_PUBKEY = expectedSECP256k1CompressedPubkey;
  console.log(`generated a fresh MPC_SECP256K1_PUBKEY=${env.MPC_SECP256K1_PUBKEY}`);
  console.log(` ➜ used by contracts to validate signatures`);
  console.log(` ➜ 💡 Set as MPC_SECP256K1_PUBKEY in the environment to skip this step on the next run`);
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
 * @throws If the compile script fails or times out.
 */
export async function compileContractZk(env: NodeJS.ProcessEnv, options: CompileContractZkOptions): Promise<void> {
  if (env[options.addressEnvVar]) {
    logSkip(options.rootScript, `${options.addressEnvVar} is set (${env[options.addressEnvVar]})`);
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
 * Run a deploy, retrying while the deployer wallet cannot yet pay the fee.
 * On a freshly started dev chain DUST generates block by block from the
 * genesis NIGHT, so the first deploy can race the chain's first minutes —
 * `Wallet.InsufficientFunds` ("could not balance dust") is transient there.
 * A genuinely unfunded wallet fails fast in the root-funding preflight
 * (see wallets.ts) instead, so the bounded retry here cannot mask real
 * underfunding.
 *
 * @param what - Step label for the retry log lines.
 * @param deploy - The deploy call to (re)attempt.
 * @returns Whatever `deploy` resolves to.
 * @throws The last error when attempts are exhausted, or immediately for
 *   any error that is not the transient insufficient-dust failure.
 */
export async function retryDeployWhileDustGenerates<T>(what: string, deploy: () => Promise<T>): Promise<T> {
  const RETRY_DELAY_MS = 15_000;
  const MAX_ATTEMPTS = 24; // ~6 minutes — a young dev chain generates plenty by then
  for (let attempt = 1; ; attempt++) {
    try {
      return await deploy();
    } catch (error) {
      const message = String(error);
      const transient = message.includes("InsufficientFunds") || message.includes("could not balance dust");
      if (!transient || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      console.log(
        `${what}: deployer cannot pay the fee yet (dust still generating on a young chain?)` +
          ` — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

/**
 * Deploy the central signet contract (the Signature Network singleton every
 * example's requester contract notifies), unless
 * `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is already set. The example's own
 * requester contract deploy is the example's step — it runs AFTER this one
 * (requesters seal the signet address at deploy time).
 *
 * @param env - The suite's env accumulator.
 * @throws If the deploy fails (after the dust-generation retries).
 */
export async function deploySignetContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
    logSkip("deploy signet contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await retryDeployWhileDustGenerates("deploy signet contract", () =>
    deploySignetContract(env),
  );
  env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the Signet singleton on Midnight: append-only logs of signature requests and MPC responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip the deploy on the next run`);
}

// The fakenet responder hand-off, automated. docker compose interpolates the
// fakenet service's environment from the repo-root .env, so the responder can
// only start once MPC_ROOT_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS are IN
// THAT FILE — the two steps below persist them (append-only) and start the
// container, right after the signet deploy so the responder boots and syncs
// while the (long) example zk compile runs. Set FAKENET_MANAGED=0 to run the
// responder yourself (e.g. `yarn response` in a solana-signet-program
// checkout for responder development) — both steps then skip.

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
 * @throws If a hand-off key in `.env` conflicts with the run's value.
 */
export function persistFakenetHandoffToDotEnv(env: NodeJS.ProcessEnv): void {
  if (env.FAKENET_MANAGED === "0") {
    logSkip("persist fakenet hand-off to .env", "FAKENET_MANAGED=0 — you manage the responder and its config yourself");
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
    logSkip("persist fakenet hand-off to .env", `${FAKENET_HANDOFF_KEYS.join(" and ")} are already in .env`);
    return;
  }
  appendRepoDotEnv(toAppend, `appended by the test-harness setup (${new Date().toISOString()}) — fakenet responder hand-off`);
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
 * @throws If docker compose fails or the container is not `running` after `up`.
 */
export async function startFakenetResponder(env: NodeJS.ProcessEnv): Promise<void> {
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
  const args = ["compose", "--profile", "fakenet", "up", "-d", ...(fakenetHandoffAppended ? ["--force-recreate"] : []), "fakenet"];
  console.log(`$ docker ${args.join(" ")}   (cwd: repo root)`);
  await runCommand("docker", args, env, 10 * MINUTE);
  const status = (await runCommand("docker", ["inspect", "-f", "{{.State.Status}}", "fakenet-responder"], env, MINUTE)).trim();
  if (status !== "running") {
    throw new Error(`fakenet-responder container is "${status}", expected "running" — check \`docker logs fakenet-responder\``);
  }
  console.log("fakenet-responder container is running");
  console.log(" ➜ watch it: `docker logs -f fakenet-responder` — healthy startup prints");
  console.log('   "MidnightMonitor: polling signet contract registry at <signet address>"');
}

/**
 * Fund the example's derived EVM accounts from the dev funder — local dev
 * chain only; on any other chain the operator funds them manually (the
 * derive steps print what to fund).
 *
 * @param env - The suite's env accumulator.
 * @param addressEnvVars - The env-var names holding the derived EVM
 *   addresses to top up (e.g. the example's user and vault accounts).
 */
export async function fundLocalEvmAccounts(
  env: NodeJS.ProcessEnv,
  addressEnvVars: readonly string[],
): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const chainId = BigInt(requireEnv(env, "EVM_CHAIN_ID"));
  if (!isLocalEvmChain(chainId)) {
    logSkip(
      "fund derived EVM accounts",
      `chain ${chainId} is not the local dev chain — fund the derived accounts manually (see the printed hints)`,
    );
    return;
  }
  const erc20Address = requireEnv(env, "ERC20_ADDRESS");
  for (const name of addressEnvVars) {
    const address = requireEnv(env, name);
    const { ethBalance, tokenBalance } = await topUpLocalAccount(rpcUrl, erc20Address, address);
    console.log(
      `topped up ${name}=${address} to ${formatEther(ethBalance)} ETH and ${formatUnits(tokenBalance, 6)} USDC`,
    );
  }
}

/**
 * Print the MPC (fakenet) responder configuration banner: the root key +
 * signet address hand-off, how the responder was (or must be) started, and
 * the minimal `.env` block that lets the next run skip every derivation.
 *
 * @param env - The suite's env accumulator.
 * @param pipelineKeys - The example's pipeline env-var names, in derivation
 *   order — printed as the ready-to-paste `.env` block.
 */
export function printMpcServerConfig(env: NodeJS.ProcessEnv, pipelineKeys: readonly string[]): void {
  const rootKey = env.MPC_ROOT_KEY ?? "(not derived here — already held by the server operator)";
  const managed = env.FAKENET_MANAGED !== "0";
  banner([
    "MPC (fakenet) responder configuration:",
    "",
    `  MPC_ROOT_KEY=${rootKey}`,
    `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS")}`,
    "  # 💡 The responder DISCOVERS requesters by polling this signet",
    "  #    contract's notification registry — no requester contract list needed.",
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
    "",
    "Minimal .env block for THIS suite:",
    "",
    ...pipelineKeys.map((key) => `  ${key}=${env[key] ?? ""}`),
    `  EVM_RPC_URL=${env.EVM_RPC_URL ?? ""}`,
  ]);
}
