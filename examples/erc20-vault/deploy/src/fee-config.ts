// The fee configuration a deployment seals at initialise and stamps on every
// ERC20 it allows: per-token fees from `VAULT_TOKEN_FEES`, the flat `VAULT_FEE_*`
// values for every token the map leaves out, and the wallet the fee coins are
// minted to. Repricing a token after bring-up is the deployer's `setTokenFees`
// call over the same map.

import type { CoinPublicKey, EncPublicKey } from "@midnightntwrk/ledger-v9";
import {
  deriveAccountKeys,
  envOrUndefined,
  getDeployConfig,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
} from "@sig-net/midnight-contract-deploy";
import { evmAddressBytes, type TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";

import { withHexPrefix } from "./evm-targets.ts";

/** Per-action fees keyed by the ERC20 they price, as lowercased 0x hex. */
export type TokenFeesByToken = ReadonlyMap<string, TokenFees>;

/** The wallet every fee coin is minted to, as the contract and midnight-js carry its keys. */
export interface FeeRecipientKeys {
  /** The Zswap coin public key the fee coins are committed to (32-byte hex). */
  readonly coinPublicKey: CoinPublicKey;
  /** The encryption public key clients encrypt the fee coin's ciphertext to (32-byte hex). */
  readonly encryptionPublicKey: EncPublicKey;
}

/**
 * The fee every action charges on the local standalone network when its
 * variable is unset, in the token's base units: a visible charge on the local
 * stack, far below any real gas cost.
 */
export const DEFAULT_TOKEN_FEE = 1000n;

const UINT64_MAX = 18446744073709551615n;

// A fee figure: a non-negative integer, as a decimal string or a safe JSON
// integer, that fits the circuit's Uint<64>.
function parseFee(name: string, value: string | number): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer in token base units, got ${text}.`);
  }
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer in token base units, got "${text}".`);
  }
  const fee = BigInt(text);
  if (fee > UINT64_MAX) {
    throw new Error(`${name} must fit a Uint<64>, got ${text}.`);
  }
  return fee;
}

// One flat fee variable: the figure it names, the local default when unset on
// the standalone network, and a refusal on a deployed one.
function resolveFlatFee(env: Record<string, string | undefined>, name: string): bigint {
  const value = envOrUndefined(env, name);
  if (value !== undefined) return parseFee(name, value);
  const { networkId } = getMidnightNodeConfig(env);
  if (isLocalStandaloneNetwork(networkId)) return DEFAULT_TOKEN_FEE;
  throw new Error(
    `${name} is required on "${networkId}": a deployed network takes no default fee, so set ` +
      "it in the token's base units or price every token in VAULT_TOKEN_FEES.",
  );
}

/**
 * Resolve the flat per-action fees stamped on every token `VAULT_TOKEN_FEES`
 * leaves unpriced, from `VAULT_FEE_WITHDRAW`, `VAULT_FEE_SWAP`,
 * `VAULT_FEE_SUPPLY` and `VAULT_FEE_REDEEM`, each in the token's base units.
 * An unset variable resolves to {@link DEFAULT_TOKEN_FEE} on the local
 * standalone network alone, since a default sized for the local stack would
 * price a deployed network's token below its gas.
 *
 * @param env - The environment to read the four variables and `NETWORK_ID` from.
 * @returns The fees, in circuit argument shape.
 * @throws {Error} If a set variable is not a non-negative integer that fits a Uint<64>, or
 *   one is unset on a deployed network.
 */
export function resolveFlatTokenFees(env: Record<string, string | undefined>): TokenFees {
  return {
    withdraw: resolveFlatFee(env, "VAULT_FEE_WITHDRAW"),
    swap: resolveFlatFee(env, "VAULT_FEE_SWAP"),
    supply: resolveFlatFee(env, "VAULT_FEE_SUPPLY"),
    redeem: resolveFlatFee(env, "VAULT_FEE_REDEEM"),
  };
}

const FEE_ACTIONS = ["withdraw", "swap", "supply", "redeem"] as const;

// One token's entry in VAULT_TOKEN_FEES: an object naming exactly the four actions.
function parseTokenFeesEntry(token: string, entry: unknown): TokenFees {
  const label = `VAULT_TOKEN_FEES[${token}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${label} must be an object naming withdraw, swap, supply and redeem.`);
  }
  const fields = entry as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!FEE_ACTIONS.some((action) => action === key)) {
      throw new Error(`${label} names "${key}", which is not a fee-charging action.`);
    }
  }
  const fee = (action: (typeof FEE_ACTIONS)[number]): bigint => {
    const value = fields[action];
    if (value === undefined) {
      throw new Error(`${label} is missing ${action}.`);
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${label}.${action} must be an integer in the token's base units.`);
    }
    return parseFee(`${label}.${action}`, value);
  };
  return {
    withdraw: fee("withdraw"),
    swap: fee("swap"),
    supply: fee("supply"),
    redeem: fee("redeem"),
  };
}

/**
 * Resolve the per-token fees `VAULT_TOKEN_FEES` prices: a JSON object mapping
 * each ERC20 address (0x optional, any case) to its `withdraw`, `swap`,
 * `supply` and `redeem` fees, each an integer in THAT token's base units, as a
 * JSON string or a safe integer. Unset or blank prices no token.
 *
 * @param env - The environment to read `VAULT_TOKEN_FEES` from.
 * @returns Each priced token's fees, keyed by its lowercased 0x address in listed order.
 * @throws {Error} If the value is not a JSON object, a key is not a 20-byte hex address or
 *   is the zero address or repeats another key, an entry is missing an action or names
 *   anything else, or a fee is not a non-negative integer that fits a Uint<64>.
 */
export function resolveTokenFeesByToken(env: Record<string, string | undefined>): TokenFeesByToken {
  const raw = envOrUndefined(env, "VAULT_TOKEN_FEES");
  if (raw === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("VAULT_TOKEN_FEES must be a JSON object keyed by ERC20 address.", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("VAULT_TOKEN_FEES must be a JSON object keyed by ERC20 address.");
  }
  const byToken = new Map<string, TokenFees>();
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const token = withHexPrefix(key.trim()).toLowerCase();
    if (evmAddressBytes(token).every((byte) => byte === 0)) {
      throw new Error("VAULT_TOKEN_FEES prices the zero address, which the vault never allows.");
    }
    if (byToken.has(token)) {
      throw new Error(`VAULT_TOKEN_FEES prices ${token} twice.`);
    }
    byToken.set(token, parseTokenFeesEntry(key, entry));
  }
  return byToken;
}

/**
 * Resolve the fees to stamp on each of `tokens`: its `VAULT_TOKEN_FEES` entry
 * when the map prices it, else the flat {@link resolveFlatTokenFees} values.
 * The flat values are read only when some token needs them, so a deployed
 * network that prices every token in the map needs no `VAULT_FEE_*`.
 *
 * @param env - The environment to read `VAULT_TOKEN_FEES` and the flat variables from.
 * @param tokens - The ERC20s to price, as 0x hex in any case.
 * @returns Each token's fees, keyed by its lowercased 0x address in `tokens` order.
 * @throws {Error} If a token is not a 20-byte hex address, or the map or a needed flat
 *   variable is malformed or missing (see {@link resolveTokenFeesByToken} and
 *   {@link resolveFlatTokenFees}).
 */
export function resolveTokenFeesFor(
  env: Record<string, string | undefined>,
  tokens: readonly string[],
): TokenFeesByToken {
  const byToken = resolveTokenFeesByToken(env);
  const fees = new Map<string, TokenFees>();
  let flat: TokenFees | undefined;
  for (const listed of tokens) {
    evmAddressBytes(listed);
    const token = listed.toLowerCase();
    const priced = byToken.get(token);
    if (priced !== undefined) {
      fees.set(token, priced);
      continue;
    }
    flat ??= resolveFlatTokenFees(env);
    fees.set(token, flat);
  }
  return fees;
}

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the wallet the fee coins are minted to: the pair
 * `VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY` / `VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY`
 * when set, else the deployer wallet's own shielded keys, derived from
 * `DEPLOYER_SEED` for the run's network. The two keys belong to one wallet, so
 * they are set together or not at all.
 *
 * @param env - The environment to read the pair, or the deployer seed and network, from.
 * @returns The recipient's coin and encryption public keys.
 * @throws {Error} If only one of the pair is set, or a set key is not 32 bytes of hex.
 */
export function resolveFeeRecipient(env: Record<string, string | undefined>): FeeRecipientKeys {
  const coinPublicKey = envOrUndefined(env, "VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY");
  const encryptionPublicKey = envOrUndefined(env, "VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY");
  if (coinPublicKey === undefined && encryptionPublicKey === undefined) {
    const deployConfig = getDeployConfig(env);
    const { shieldedSecretKeys } = deriveAccountKeys(
      deployConfig.deployerSeed,
      deployConfig.midnightNodeConfig.networkId,
    );
    return {
      coinPublicKey: shieldedSecretKeys.coinPublicKey,
      encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
    };
  }
  if (coinPublicKey === undefined || encryptionPublicKey === undefined) {
    throw new Error(
      "VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY and VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY name " +
        "one wallet, so set both or neither.",
    );
  }
  for (const [name, value] of [
    ["VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY", coinPublicKey],
    ["VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY", encryptionPublicKey],
  ] as const) {
    if (!KEY_HEX.test(value)) {
      throw new Error(`${name} must be 32 bytes of hex, got "${value}".`);
    }
  }
  return {
    coinPublicKey: coinPublicKey.toLowerCase(),
    encryptionPublicKey: encryptionPublicKey.toLowerCase(),
  };
}

/**
 * Render fees for a log line.
 *
 * @param fees - The fees to render.
 * @returns One line naming each action's fee in base units.
 */
export function formatTokenFees(fees: TokenFees): string {
  return (
    `withdraw ${String(fees.withdraw)}, swap ${String(fees.swap)}, ` +
    `supply ${String(fees.supply)}, redeem ${String(fees.redeem)}`
  );
}
