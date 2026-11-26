import { bytesToHex, tronAddressFromBase58 } from "@sig-net/midnight";
import {
  envOrUndefined,
  getNetworkId,
  MidnightNetwork,
  type NetworkId,
} from "@sig-net/midnight-contract-deploy";
import { evmAddressBytes, type TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";

import { withHexPrefix } from "./evm-targets.ts";
import { resolveTokenFeesFor } from "./fee-config.ts";

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
 * @param entry - A TRC-20 as a base58 Tron address or 20-byte hex (0x optional, any case)
 * @returns Its 20-byte form, the one the vault keys it by, as lowercased 0x hex
 * @throws {Error} If the entry is neither form
 */
export function tronTokenAddress(entry: string): string {
  return `0x${bytesToHex(tronTokenEvmForm(entry))}`;
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

/**
 * A TRC-20's listing, as `addAllowedTronToken` records it: the fees and the factor, fixed at
 * listing, that one coin unit counts in the token's base units.
 */
export interface TronTokenListing {
  /** The per-action fees, in the token's coin units. */
  readonly fees: TokenFees;
  /** Base units per coin unit: 10^s, 1 for an unshifted token. */
  readonly factor: bigint;
}

/** Each TRC-20's listing, keyed by its 20-byte form as lowercased 0x hex. */
export type TronTokenListings = ReadonlyMap<string, TronTokenListing>;

const UINT64_MAX = 2n ** 64n - 1n;

// One TRON_TOKEN_FACTORS entry: a positive integer, as a decimal string or a safe JSON
// integer, that fits the circuit's Uint<64>.
function parseTronTokenFactor(label: string, value: unknown): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer, got ${String(value)}.`);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} must be a positive integer, as a string or a number.`);
  }
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} must be a positive integer, got "${text}".`);
  }
  const factor = BigInt(text);
  if (factor > UINT64_MAX) {
    throw new Error(`${label} must fit a Uint<64>, got ${text}.`);
  }
  return factor;
}

/**
 * Resolve the factors `TRON_TOKEN_FACTORS` gives: a JSON object mapping a TRC-20 (base58 or
 * 20-byte hex, 0x optional, any case) to its factor, the base units one coin unit counts
 * (10^s), as a positive integer string or a safe integer. Unset or blank gives no factor.
 *
 * @param env - The environment to read `TRON_TOKEN_FACTORS` from.
 * @returns Each named token's factor, keyed by its 20-byte form as lowercased 0x hex.
 * @throws {Error} If the value is not a JSON object, a key is neither address form or is the
 *   zero address or names a token twice, or a factor is not a positive integer that fits a
 *   Uint<64>.
 */
export function resolveTronTokenFactors(
  env: Record<string, string | undefined>,
): ReadonlyMap<string, bigint> {
  const raw = envOrUndefined(env, "TRON_TOKEN_FACTORS");
  if (raw === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("TRON_TOKEN_FACTORS must be a JSON object keyed by TRC-20 address.", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TRON_TOKEN_FACTORS must be a JSON object keyed by TRC-20 address.");
  }
  const factors = new Map<string, bigint>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const evmForm = tronTokenEvmForm(key.trim());
    if (evmForm.every((byte) => byte === 0)) {
      throw new Error("TRON_TOKEN_FACTORS names the zero address, which the vault never allows.");
    }
    const token = `0x${bytesToHex(evmForm)}`;
    if (factors.has(token)) {
      throw new Error(`TRON_TOKEN_FACTORS names ${token} twice.`);
    }
    factors.set(token, parseTronTokenFactor(`TRON_TOKEN_FACTORS[${key}]`, value));
  }
  return factors;
}

/**
 * Resolve the listing of every TRC-20 `TRON_ALLOWED_TOKENS` lists: its fees from
 * `VAULT_TOKEN_FEES` or the flat `VAULT_FEE_*` values (see {@link resolveTokenFeesFor}), in
 * the token's coin units, and its factor from `TRON_TOKEN_FACTORS`, 1 when the map leaves
 * it out. A factor is fixed at listing, so a factor naming a token the list leaves out (a
 * mistyped key) is refused rather than leaving that token at factor 1 for good, and so is
 * a list naming `TRON_LEND_SHARE_TOKEN` without a factor for it.
 *
 * @param env - The environment to read the list, the fees, the factors and
 *   `TRON_LEND_SHARE_TOKEN` from.
 * @returns Each listed token's listing, in listed order.
 * @throws {Error} If the list, the fees or the factors are malformed (see
 *   {@link resolveAllowedTronTokens}, {@link resolveTokenFeesFor} and
 *   {@link resolveTronTokenFactors}), the list names tokens and a factor names one it
 *   leaves out, or the list names the lend share token and no factor does.
 */
export function resolveTronTokenListings(
  env: Record<string, string | undefined>,
): TronTokenListings {
  const factors = resolveTronTokenFactors(env);
  const listings = new Map<string, TronTokenListing>();
  for (const [token, fees] of resolveTokenFeesFor(env, resolveAllowedTronTokens(env))) {
    listings.set(token, { fees, factor: factors.get(token) ?? 1n });
  }
  if (listings.size > 0) {
    for (const token of factors.keys()) {
      if (!listings.has(token)) {
        throw new Error(
          `TRON_TOKEN_FACTORS names ${token}, which TRON_ALLOWED_TOKENS does not list.`,
        );
      }
    }
  }
  const shareToken = envOrUndefined(env, "TRON_LEND_SHARE_TOKEN");
  if (shareToken !== undefined) {
    const token = tronTokenAddress(shareToken);
    if (listings.has(token) && !factors.has(token)) {
      throw new Error(
        `TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN ${token}: its factor is fixed at ` +
          "listing, and at factor 1 an 18-decimal share token's larger supplies cannot settle.",
      );
    }
  }
  return listings;
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
