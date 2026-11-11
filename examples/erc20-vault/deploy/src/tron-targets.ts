import { bytesToHex, tronAddressFromBase58 } from "@sig-net/midnight";
import { envOrUndefined } from "@sig-net/midnight-contract-deploy";
import { evmAddressBytes } from "@sig-net/midnight-examples-erc20-vault-contract";

import { withHexPrefix } from "./evm-targets.ts";

interface TronNowBlock {
  readonly block_header?: { readonly raw_data?: { readonly number?: number } };
}

/**
 * @param rpcUrl - The node's HTTP API base URL
 * @returns The latest block number
 * @throws {Error} If the node does not answer with a block number
 */
export async function getTronBlockNumber(rpcUrl: string): Promise<bigint> {
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}/wallet/getnowblock`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Tron getnowblock answered HTTP ${String(response.status)}`);
  }
  const block = (await response.json()) as TronNowBlock;
  const number = block.block_header?.raw_data?.number;
  if (number === undefined) {
    throw new Error("Tron getnowblock returned no block_header.raw_data.number");
  }
  return BigInt(number);
}

/**
 * @param env - The environment to read `TRON_START_HEIGHT` and `TRON_RPC_URL` from
 * @returns The start height
 * @throws {Error} If `TRON_START_HEIGHT` is malformed or `TRON_RPC_URL` does not answer
 */
export async function resolveTronStartHeight(
  env: Record<string, string | undefined>,
): Promise<bigint> {
  const preset = envOrUndefined(env, "TRON_START_HEIGHT");
  if (preset !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(preset)) {
      throw new Error(`TRON_START_HEIGHT must be a non-negative integer, got "${preset}".`);
    }
    return BigInt(preset);
  }
  const rpcUrl = envOrUndefined(env, "TRON_RPC_URL");
  if (rpcUrl === undefined) return 0n;
  try {
    return await getTronBlockNumber(rpcUrl);
  } catch (error) {
    throw new Error(
      `TRON_RPC_URL (${rpcUrl}) is not answering, so the Tron start height cannot be read`,
      { cause: error },
    );
  }
}

/**
 * @param env - The environment to read `TRON_ALLOWED_TOKENS` from
 * @returns The listed TRC-20s in the 20-byte form the vault keys them by
 * @throws {Error} If an entry is neither form or is the zero address
 */
export function resolveAllowedTronTokens(
  env: Record<string, string | undefined>,
): readonly string[] {
  const listed = envOrUndefined(env, "TRON_ALLOWED_TOKENS");
  if (!listed) return [];
  const tokens: string[] = [];
  for (const entry of listed.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const evmForm = trimmed.startsWith("T")
      ? tronAddressFromBase58(trimmed).slice(1)
      : evmAddressBytes(withHexPrefix(trimmed));
    if (evmForm.every((byte) => byte === 0)) {
      throw new Error("TRON_ALLOWED_TOKENS lists the zero address, which the vault never allows.");
    }
    const token = `0x${bytesToHex(evmForm)}`;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}
