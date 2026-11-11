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
  const rpcUrl = requireEnv(env, "TRON_RPC_URL");
  const funder = await resolveTronFunder(env);
  const supplyWord = TEST_TRC20_SUPPLY.toString(16).padStart(64, "0");
  const { address, txid } = await deployTronContract(
    rpcUrl,
    funder,
    "TestTrc20",
    TEST_TRC20_ABI,
    TEST_TRC20_BYTECODE + supplyWord,
  );
  const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
  if (info.receiptResult !== "SUCCESS") {
    throw new Error(`the test TRC-20 deploy ran ${info.receiptResult}`);
  }
  env.TRC20_ADDRESS = `0x${bytesToHex(address.slice(1))}`;
  console.log(`deployed the test TRC-20 at TRC20_ADDRESS=${env.TRC20_ADDRESS}`);
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
  env.TRON_ALLOWED_TOKENS = requireEnv(env, "TRC20_ADDRESS");
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
  const token = tronAddressFromEvm(requireEnv(env, "TRC20_ADDRESS"));

  const trx = await getTrxBalance(rpcUrl, user);
  if (trx < USER_TRX_FLOOR) {
    const txid = await sendTrx(rpcUrl, funder, user, USER_TRX_FLOOR - trx);
    await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
    console.log(`sent ${String(USER_TRX_FLOOR - trx)} sun to ${env.TRON_USER_ADDRESS ?? ""}`);
  }
  const tokens = await getTrc20Balance(rpcUrl, token, user);
  if (tokens < USER_TRC20_FLOOR) {
    const txid = await sendTrc20(rpcUrl, funder, token, user, USER_TRC20_FLOOR - tokens);
    const info = await waitForTronTransaction(rpcUrl, txid, TRON_TX_TIMEOUT_MS);
    if (info.receiptResult !== "SUCCESS") {
      throw new Error(`the TRC-20 funding transfer ran ${info.receiptResult}`);
    }
    console.log(`sent ${String(USER_TRC20_FLOOR - tokens)} TRC-20 base units to the user`);
  }
}
