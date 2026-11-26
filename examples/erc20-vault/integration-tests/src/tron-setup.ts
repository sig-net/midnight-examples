import {
  bytesToHex,
  deriveTronAddress,
  tronAddressFromBase58,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import { envOrUndefined } from "@sig-net/midnight-contract-deploy";
import { deriveVaultTronAddress } from "@sig-net/midnight-examples-erc20-vault-contract";
import { tronTokenAddress } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { logSkip, requireEnv } from "@sig-net/midnight-examples-test-harness";

import { TEST_ERC4626_ABI, TEST_ERC4626_BYTECODE } from "./test-erc4626.ts";
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
  "TRON_LEND_SHARE_TOKEN",
  "TRON_LEND_UNDERLYING",
  "TRON_LEND_MIN_SUPPLY",
  "TRON_TOKEN_FACTORS",
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

// A TRON_ALLOWED_TOKENS set without a lend share token lists no share token, so the setup
// leaves the lend pair unset rather than deploy one the vault would never list.
function tronLendConfigured(env: NodeJS.ProcessEnv, step: string): boolean {
  if (!tronConfigured(env, step)) return false;
  if (!env.TRON_ALLOWED_TOKENS || env.TRON_LEND_SHARE_TOKEN) return true;
  logSkip(
    step,
    "TRON_ALLOWED_TOKENS is set without TRON_LEND_SHARE_TOKEN: the lend pair stays unset and " +
      "tron-lend-e2e fails its preflight (unset TRON_ALLOWED_TOKENS to let the setup list one)",
  );
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
 * Deploy the test ERC-4626 (OpenZeppelin 5, decimals offset 12: 18-decimal shares over the
 * 6-decimal USDT-like TRC-20, as JustLend V2's jUSDTv2 over Tron USDT) as
 * `TRON_LEND_SHARE_TOKEN`, unless one is set or `TRON_ALLOWED_TOKENS` is set without one.
 *
 * @param env - The suite's env accumulator
 * @throws {Error} If `TRON_USDT_ADDRESS` is unset, or the deploy is refused or does not land
 */
export async function ensureTestErc4626(env: NodeJS.ProcessEnv): Promise<void> {
  if (!tronLendConfigured(env, "deploy test ERC-4626")) return;
  if (env.TRON_LEND_SHARE_TOKEN) {
    logSkip("deploy test ERC-4626", `TRON_LEND_SHARE_TOKEN is set (${env.TRON_LEND_SHARE_TOKEN})`);
    return;
  }
  const rpcUrl = requireEnv(env, "TRON_RPC_URL");
  const funder = await resolveTronFunder(env);
  const asset = tronTokenAddress(requireEnv(env, "TRON_USDT_ADDRESS"));
  const assetWord = asset.slice(2).padStart(64, "0");
  const { address, txid } = await deployTronContract(
    rpcUrl,
    funder,
    "TestErc4626",
    TEST_ERC4626_ABI,
    TEST_ERC4626_BYTECODE + assetWord,
  );
  const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
  if (info.receiptResult !== "SUCCESS") {
    throw new Error(`the test ERC-4626 deploy ran ${info.receiptResult}`);
  }
  env.TRON_LEND_SHARE_TOKEN = `0x${bytesToHex(address.slice(1))}`;
  console.log(`deployed the test ERC-4626 at TRON_LEND_SHARE_TOKEN=${env.TRON_LEND_SHARE_TOKEN}`);
}

// The test ERC-4626's shares carry 12 decimals more than its asset.
const TEST_SHARE_FACTOR = 10n ** 12n;

// One USDT-like coin: a supply smaller than it would mint almost no share coin units.
const TEST_LEND_MIN_SUPPLY = 1_000_000n;

/**
 * Default the Tron lend pair to the USDT-like TRC-20 under the test ERC-4626, with a
 * minimum supply of one token, and the share token's factor to 10^12. Each variable already
 * set is kept; with `TRON_ALLOWED_TOKENS` set and no share token, none is defaulted.
 *
 * @param env - The suite's env accumulator
 */
export function ensureTronLendDefaults(env: NodeJS.ProcessEnv): void {
  if (!tronLendConfigured(env, "default the Tron lend pair")) return;
  const shareToken = requireEnv(env, "TRON_LEND_SHARE_TOKEN");
  env.TRON_LEND_UNDERLYING =
    envOrUndefined(env, "TRON_LEND_UNDERLYING") ?? requireEnv(env, "TRON_USDT_ADDRESS");
  env.TRON_LEND_MIN_SUPPLY =
    envOrUndefined(env, "TRON_LEND_MIN_SUPPLY") ?? String(TEST_LEND_MIN_SUPPLY);
  env.TRON_TOKEN_FACTORS =
    envOrUndefined(env, "TRON_TOKEN_FACTORS") ??
    JSON.stringify({ [shareToken]: String(TEST_SHARE_FACTOR) });
  console.log(
    `Tron lend pair ${env.TRON_LEND_UNDERLYING} -> ${shareToken}, min supply ` +
      `${env.TRON_LEND_MIN_SUPPLY}, TRON_TOKEN_FACTORS=${env.TRON_TOKEN_FACTORS}`,
  );
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
  env.TRON_ALLOWED_TOKENS = [
    requireEnv(env, "TRC20_ADDRESS"),
    env.TRON_USDT_ADDRESS,
    env.TRON_LEND_SHARE_TOKEN,
  ]
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
