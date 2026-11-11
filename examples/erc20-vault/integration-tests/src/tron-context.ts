import { type TronAddress, tronAddressFromBase58 } from "@sig-net/midnight";
import { evmAddressBytes } from "@sig-net/midnight-examples-erc20-vault-contract";
import { requireEnv } from "@sig-net/midnight-examples-test-harness";

import { type TronFunder, tronFunder } from "./tron-http.ts";

/** */
export interface TronContext {
  readonly tronRpcUrl: string;
  readonly trc20Address: Uint8Array;
  readonly tronUserAddress: TronAddress;
  readonly tronVaultAddress: TronAddress;
  readonly funder: TronFunder;
}

interface TreAccounts {
  readonly privateKeys?: readonly string[];
}

/**
 * @param env - The suite's env accumulator
 * @returns The funder
 * @throws {Error} If neither source yields a key
 */
export async function resolveTronFunder(env: NodeJS.ProcessEnv): Promise<TronFunder> {
  const preset = env.TRON_FUNDER_PRIVATE_KEY;
  if (preset) return tronFunder(preset.startsWith("0x") ? preset : `0x${preset}`);
  const rpcUrl = requireEnv(env, "TRON_RPC_URL");
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}/admin/accounts-json`);
  const accounts = (await response.json()) as TreAccounts;
  const key = accounts.privateKeys?.[0];
  if (key === undefined) {
    throw new Error(
      `TRON_FUNDER_PRIVATE_KEY is unset and ${rpcUrl}/admin/accounts-json lists no prefunded key`,
    );
  }
  return tronFunder(`0x${key}`);
}

/**
 * @param env - The suite's env accumulator
 * @returns The context
 * @throws {Error} If a value is missing or malformed
 */
export async function createTronContext(env: NodeJS.ProcessEnv): Promise<TronContext> {
  const userBytes = tronAddressFromBase58(requireEnv(env, "TRON_USER_ADDRESS"));
  const vaultBytes = tronAddressFromBase58(requireEnv(env, "TRON_VAULT_ADDRESS"));
  return {
    tronRpcUrl: requireEnv(env, "TRON_RPC_URL"),
    trc20Address: evmAddressBytes(requireEnv(env, "TRC20_ADDRESS")),
    tronUserAddress: { bytes: userBytes, base58: requireEnv(env, "TRON_USER_ADDRESS") },
    tronVaultAddress: { bytes: vaultBytes, base58: requireEnv(env, "TRON_VAULT_ADDRESS") },
    funder: await resolveTronFunder(env),
  };
}
