// Which EVM contracts a deployment configures the vault with: the ones it pins
// at `initialise` time, and the ERC20s it allows afterwards. The pinned
// addresses default to the contract package's canonicals. Resolving WHICH ones
// a given deploy uses is configuration, hence deploy's job.

import { envOrUndefined } from "@sig-net/midnight-contract-deploy";
import {
  AAVE_USDC,
  evmAddressBytes,
  STATA_USDC,
  UNISWAP_SWAP_ROUTER_02,
} from "@sig-net/midnight-examples-erc20-vault-contract";

/** The EVM contracts `initialise` seals into the vault. */
export interface VaultEvmTargets {
  /** The Uniswap SwapRouter02 the swap circuits call. */
  readonly routerAddress: string;
  /** The Aave underlying token the supply circuit lends. */
  readonly stataUnderlyingAddress: string;
  /** The ERC-4626 wrapper the supply/redeem circuits mint and burn. */
  readonly stataTokenAddress: string;
}

// An operator may paste an EVM address override with or without the `0x`
// prefix, and `evmAddressBytes` accepts only the prefixed form. Width and hex
// digits stay its check.
function withHexPrefix(address: string): string {
  return /^0x/i.test(address) ? address : `0x${address}`;
}

/**
 * Resolve the EVM targets from the environment, defaulting each to its Sepolia
 * canonical. Blank values count as unset, so an empty `.env` line falls back to
 * the default rather than pinning the zero address.
 *
 * @param env - The environment to read `EVM_ROUTER`, `EVM_STATA_UNDERLYING` and
 *   `EVM_STATA_TOKEN` from.
 * @returns The resolved targets.
 */
export function resolveEvmTargets(env: Record<string, string | undefined>): VaultEvmTargets {
  const override = (name: string, fallback: string): string => {
    const value = envOrUndefined(env, name);
    return value ? withHexPrefix(value) : fallback;
  };
  return {
    routerAddress: override("EVM_ROUTER", UNISWAP_SWAP_ROUTER_02),
    stataUnderlyingAddress: override("EVM_STATA_UNDERLYING", AAVE_USDC),
    stataTokenAddress: override("EVM_STATA_TOKEN", STATA_USDC),
  };
}

/**
 * Resolve the ERC20s `EVM_ALLOWED_TOKENS` lists for the deployer to allow
 * after `initialise`, which allows the stata underlying itself. The list is
 * comma-separated, each entry with or without its `0x` prefix, and repeats
 * (in any case) collapse to the first. Unset or blank lists nothing.
 *
 * @param env - The environment to read `EVM_ALLOWED_TOKENS` from.
 * @returns The listed ERC20s as 0x hex, in listed order.
 * @throws {Error} If an entry is not a 20-byte hex address or is the zero address.
 */
export function resolveAllowedTokens(env: Record<string, string | undefined>): readonly string[] {
  const listed = envOrUndefined(env, "EVM_ALLOWED_TOKENS");
  if (!listed) return [];
  const tokens: string[] = [];
  for (const entry of listed.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const token = withHexPrefix(trimmed);
    if (evmAddressBytes(token).every((byte) => byte === 0)) {
      throw new Error("EVM_ALLOWED_TOKENS lists the zero address, which the vault never allows.");
    }
    if (!tokens.some((seen) => seen.toLowerCase() === token.toLowerCase())) tokens.push(token);
  }
  return tokens;
}
