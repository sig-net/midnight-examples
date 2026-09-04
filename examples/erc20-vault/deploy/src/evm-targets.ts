// Which EVM contracts a deployment pins into the vault at `initialise` time.
// The addresses themselves are the contract package's canonicals; resolving
// WHICH ones a given deploy seals is configuration, hence deploy's job.

import {
  AAVE_USDC,
  STATA_USDC,
  UNISWAP_SWAP_ROUTER_02,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { envOrUndefined } from "@sig-net/midnight-examples-lib";

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
 * @param env - The environment to read `UNISWAP_ROUTER_CONTRACT_ADDRESS`, `AAVE_STATA_UNDERLYING_TOKEN_CONTRACT_ADDRESS` and `AAVE_STATA_TOKEN_CONTRACT_ADDRESS` from.
 * @returns The resolved targets.
 */
export function resolveEvmTargets(env: Record<string, string | undefined>): VaultEvmTargets {
  const override = (name: string, fallback: string): string => {
    const value = envOrUndefined(env, name);
    return value ? withHexPrefix(value) : fallback;
  };
  return {
    routerAddress: override("UNISWAP_ROUTER_CONTRACT_ADDRESS", UNISWAP_SWAP_ROUTER_02),
    stataUnderlyingAddress: override("AAVE_STATA_UNDERLYING_TOKEN_CONTRACT_ADDRESS", AAVE_USDC),
    stataTokenAddress: override("AAVE_STATA_TOKEN_CONTRACT_ADDRESS", STATA_USDC),
  };
}
