import { bytesToHex, tronAddressFromBase58 } from "@sig-net/midnight";
import {
  envOrUndefined,
  getNetworkId,
  MidnightNetwork,
  type NetworkId,
} from "@sig-net/midnight-contract-deploy";
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
    signal: AbortSignal.timeout(30_000),
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

function tronTokenEvmForm(entry: string): Uint8Array {
  return entry.startsWith("T")
    ? tronAddressFromBase58(entry).slice(1)
    : evmAddressBytes(withHexPrefix(entry));
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
    const evmForm = tronTokenEvmForm(trimmed);
    if (evmForm.every((byte) => byte === 0)) {
      throw new Error("TRON_ALLOWED_TOKENS lists the zero address, which the vault never allows.");
    }
    const token = `0x${bytesToHex(evmForm)}`;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

const KNOWN_TRON_USDT: Partial<Record<NetworkId, string>> = {
  [MidnightNetwork.Preprod]: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  [MidnightNetwork.Mainnet]: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
};

/**
 * @param env - The environment to read `TRON_USDT_ADDRESS` and `NETWORK_ID` from
 * @returns The Tron USDT contract in the 20-byte form: `TRON_USDT_ADDRESS` when set, else the
 *   network's known USDT (Nile on preprod, mainnet USDT on mainnet), else the zero address
 * @throws {Error} If the value is neither a base58 Tron address nor a 20-byte hex address
 */
export function resolveTronUsdtAddress(env: Record<string, string | undefined>): string {
  const value = envOrUndefined(env, "TRON_USDT_ADDRESS") ?? KNOWN_TRON_USDT[getNetworkId(env)];
  if (!value) return `0x${"00".repeat(20)}`;
  return `0x${bytesToHex(tronTokenEvmForm(value))}`;
}

/**
 * @param allowedTronTokens - The TRC-20s the deploy allows, in the 20-byte form
 * @param tronUsdtAddress - The Tron USDT contract `initialise` seals, in the 20-byte form
 * @throws {Error} If a known USDT is allowed while `tronUsdtAddress` is the zero address
 */
export function assertTronUsdtSealedIfAllowed(
  allowedTronTokens: readonly string[],
  tronUsdtAddress: string,
): void {
  if (!evmAddressBytes(tronUsdtAddress).every((byte) => byte === 0)) return;
  const knownUsdt = Object.values(KNOWN_TRON_USDT).flatMap((base58) =>
    base58 === undefined ? [] : [`0x${bytesToHex(tronTokenEvmForm(base58))}`],
  );
  const listed = allowedTronTokens.find((token) => knownUsdt.includes(token.toLowerCase()));
  if (listed === undefined) return;
  throw new Error(
    `TRON_ALLOWED_TOKENS lists the Tron USDT ${listed}, but the tronUsdtAddress initialise ` +
      "seals is the zero address, so the vault would read USDT's false transfer result as a " +
      "failure. Set TRON_USDT_ADDRESS to that USDT, or remove it from TRON_ALLOWED_TOKENS.",
  );
}
