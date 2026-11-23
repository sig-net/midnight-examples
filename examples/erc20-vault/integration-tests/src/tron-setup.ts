import {
  bytesToHex,
  deriveTronAddress,
  tronAddressFromBase58,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import { deriveVaultTronAddress } from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip, requireEnv } from "@sig-net/midnight-examples-test-harness";

import { TEST_TRC20_ABI, TEST_TRC20_BYTECODE } from "./test-trc20.ts";
import { resolveTronFunder } from "./tron-context.ts";
import {
  deployTronContract,
  getTrc20Balance,
  getTrxBalance,
  sendTrc20,
  sendTrx,
  waitForTronTransaction,
} from "./tron-http.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

/** */
export const TRON_PIPELINE_KEYS = [
  "TRC20_ADDRESS",
  "TRON_USDT_ADDRESS",
  "TRON_SUNSWAP_ROUTER",
  "TRON_ALLOWED_TOKENS",
  "TRON_VAULT_ADDRESS",
  "TRON_USER_ADDRESS",
] as const;

const TRON_TX_TIMEOUT_MS = 60_000;

function tronConfigured(env: NodeJS.ProcessEnv, step: string): boolean {
  if (env.TRON_RPC_URL) return true;
  logSkip(step, "TRON_RPC_URL is unset: no Tron chain in this run, the Tron specs skip");
  return false;
}

const TEST_TRC20_SUPPLY = 10n ** 15n;

async function deployTestTrc20(env: NodeJS.ProcessEnv, usdtLike: boolean): Promise<string> {
  const rpcUrl = requireEnv(env, "TRON_RPC_URL");
  const funder = await resolveTronFunder(env);
  const supplyWord = TEST_TRC20_SUPPLY.toString(16).padStart(64, "0");
  const usdtLikeWord = (usdtLike ? 1n : 0n).toString(16).padStart(64, "0");
  const { address, txid } = await deployTronContract(
    rpcUrl,
    funder,
    "TestTrc20",
    TEST_TRC20_ABI,
    TEST_TRC20_BYTECODE + supplyWord + usdtLikeWord,
  );
  const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
  if (info.receiptResult !== "SUCCESS") {
    throw new Error(`the test TRC-20 deploy ran ${info.receiptResult}`);
  }
  return `0x${bytesToHex(address.slice(1))}`;
}

/**
 * @param env - The suite's env accumulator
 * @throws {Error} If the deploy is refused or does not land
 */
export async function ensureTestTrc20(env: NodeJS.ProcessEnv): Promise<void> {
  if (!tronConfigured(env, "deploy test TRC-20")) return;
  if (env.TRC20_ADDRESS) {
    logSkip("deploy test TRC-20", `TRC20_ADDRESS is set (${env.TRC20_ADDRESS})`);
    return;
  }
  env.TRC20_ADDRESS = await deployTestTrc20(env, false);
  console.log(`deployed the test TRC-20 at TRC20_ADDRESS=${env.TRC20_ADDRESS}`);
}

/**
 * @param env - The suite's env accumulator
 * @throws {Error} If the deploy is refused or does not land
 */
export async function ensureTestUsdtLikeTrc20(env: NodeJS.ProcessEnv): Promise<void> {
  if (!tronConfigured(env, "deploy USDT-like test TRC-20")) return;
  if (env.TRON_USDT_ADDRESS) {
    logSkip("deploy USDT-like test TRC-20", `TRON_USDT_ADDRESS is set (${env.TRON_USDT_ADDRESS})`);
    return;
  }
  env.TRON_USDT_ADDRESS = await deployTestTrc20(env, true);
  console.log(`deployed the USDT-like test TRC-20 at TRON_USDT_ADDRESS=${env.TRON_USDT_ADDRESS}`);
}

/**
 * @param env - The suite's env accumulator
 */
export function ensureTronAllowedTokens(env: NodeJS.ProcessEnv): void {
  if (!tronConfigured(env, "default TRON_ALLOWED_TOKENS")) return;
  if (env.TRON_ALLOWED_TOKENS) {
    logSkip("default TRON_ALLOWED_TOKENS", `TRON_ALLOWED_TOKENS is set`);
    return;
  }
  env.TRON_ALLOWED_TOKENS = [requireEnv(env, "TRC20_ADDRESS"), env.TRON_USDT_ADDRESS]
    .filter((token) => token !== undefined && token !== "")
    .join(",");
  console.log(`defaulted TRON_ALLOWED_TOKENS=${env.TRON_ALLOWED_TOKENS}`);
}

function ensureDerivedTronAddress(env: NodeJS.ProcessEnv, name: string, derived: string): void {
  const preset = env[name];
  if (preset) {
    if (preset !== derived) {
      throw new Error(
        `${name} should be derived from MPC_SECP256K1_PUBKEY + vault contract: expected ${derived}, found ${preset}`,
      );
    }
    logSkip(`check/derive ${name}`, `${name} is set correctly`);
    return;
  }
  env[name] = derived;
  console.log(`derived ${name}=${derived}`);
}

/**
 * @param env - The suite's env accumulator
 * @throws {Error} If a preset address mismatches its derivation
 */
export function ensureTronAddresses(env: NodeJS.ProcessEnv): void {
  if (!tronConfigured(env, "check/derive Tron addresses")) return;
  const mpcKey = requireEnv(env, "MPC_SECP256K1_PUBKEY");
  const vaultAddress = requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  ensureDerivedTronAddress(
    env,
    "TRON_VAULT_ADDRESS",
    deriveVaultTronAddress(mpcKey, vaultAddress).base58,
  );
  ensureDerivedTronAddress(
    env,
    "TRON_USER_ADDRESS",
    deriveTronAddress(mpcKey, vaultAddress, resolveUserIdentity(env).commitmentHex).base58,
  );
}

const USER_TRX_FLOOR = 2_000_000_000n;

// The vault's own Tron account pays its withdrawals' energy, up to the fee limit each.
const VAULT_TRX_FLOOR = 2_000_000_000n;

const USER_TRC20_FLOOR = 100_000_000n;

/**
 * @param env - The suite's env accumulator
 * @throws {Error} If a funding transfer is refused or does not land
 */
export async function fundTronAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  if (!tronConfigured(env, "fund derived Tron accounts")) return;
  const rpcUrl = requireEnv(env, "TRON_RPC_URL");
  const funder = await resolveTronFunder(env);
  const user = tronAddressFromBase58(requireEnv(env, "TRON_USER_ADDRESS"));

  for (const [name, floor] of [
    ["TRON_USER_ADDRESS", USER_TRX_FLOOR],
    ["TRON_VAULT_ADDRESS", VAULT_TRX_FLOOR],
  ] as const) {
    const account = tronAddressFromBase58(requireEnv(env, name));
    const trx = await getTrxBalance(rpcUrl, account);
    if (trx < floor) {
      const txid = await sendTrx(rpcUrl, funder, account, floor - trx);
      await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
      console.log(`sent ${String(floor - trx)} sun to ${name} ${env[name] ?? ""}`);
    }
  }
  for (const name of ["TRC20_ADDRESS", "TRON_USDT_ADDRESS"]) {
    const address = name === "TRC20_ADDRESS" ? requireEnv(env, name) : env[name];
    if (!address) continue;
    const token = address.startsWith("T")
      ? tronAddressFromBase58(address)
      : tronAddressFromEvm(address);
    const tokens = await getTrc20Balance(rpcUrl, token, user);
    if (tokens < USER_TRC20_FLOOR) {
      const txid = await sendTrc20(rpcUrl, funder, token, user, USER_TRC20_FLOOR - tokens);
      const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
      if (info.receiptResult !== "SUCCESS") {
        throw new Error(`the ${name} funding transfer ran ${info.receiptResult}`);
      }
      console.log(`sent ${String(USER_TRC20_FLOOR - tokens)} ${name} base units to the user`);
    }
  }
}
