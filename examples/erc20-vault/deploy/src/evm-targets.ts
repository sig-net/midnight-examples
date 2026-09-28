// Which EVM contracts a deployment pins into the vault at `initialise` time.
// The addresses themselves are the contract package's canonicals. Resolving
// WHICH ones a given deploy seals is configuration, hence deploy's job.

import { envOrUndefined } from "@sig-net/midnight-contract-deploy";
import {
  AAVE_USDC,
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
  readonly allowedTokens: readonly string[];
}

/** The width of the `allowedTokenList` vector `initialise` takes. */
export const ALLOWED_TOKEN_SLOTS = 8;

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
 * @param env - The environment to read `EVM_ROUTER`, `EVM_STATA_UNDERLYING`,
 *   `EVM_STATA_TOKEN` and `ALLOWED_TOKENS` (comma-separated, defaulting to the stata
 *   underlying plus `ERC20_ADDRESS` when set) from.
 * @returns The resolved targets.
 * @throws {Error} If more than `ALLOWED_TOKEN_SLOTS` tokens are listed.
 */
export function resolveEvmTargets(env: Record<string, string | undefined>): VaultEvmTargets {
  const override = (name: string, fallback: string): string => {
    const value = envOrUndefined(env, name);
    return value ? withHexPrefix(value) : fallback;
  };
  const stataUnderlyingAddress = override("EVM_STATA_UNDERLYING", AAVE_USDC);
  const listed =
    envOrUndefined(env, "ALLOWED_TOKENS")
      ?.split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "")
      .map(withHexPrefix) ?? [override("ERC20_ADDRESS", "")].filter((token) => token !== "");
  const allowedTokens = [stataUnderlyingAddress, ...listed].filter(
    (token, index, all) =>
      all.findIndex((other) => other.toLowerCase() === token.toLowerCase()) === index,
  );
  if (allowedTokens.length > ALLOWED_TOKEN_SLOTS) {
    throw new Error(
      `ALLOWED_TOKENS lists ${String(allowedTokens.length)} tokens including the stata underlying; initialise takes at most ${String(ALLOWED_TOKEN_SLOTS)}`,
    );
  }
  return {
    routerAddress: override("EVM_ROUTER", UNISWAP_SWAP_ROUTER_02),
    stataUnderlyingAddress,
    stataTokenAddress: override("EVM_STATA_TOKEN", STATA_USDC),
    allowedTokens,
  };
}
