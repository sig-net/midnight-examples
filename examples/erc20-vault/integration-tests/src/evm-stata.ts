// Aave ERC-4626 (stataToken) constants for the supply/redeem flows: the pinned Aave USDC
// pair on Sepolia and the deposit/redeem ABI shapes. Mirrors evm-swap.ts for the lending
// leg.
import { STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { ethers } from "ethers";

/** deposit(uint256,address) selector (ERC-4626, verified present on the wrapper impl). */
export const STATA_DEPOSIT_SELECTOR = new Uint8Array([0x6e, 0x55, 0x3f, 0x65]);

/** redeem(uint256,address,address) selector (ERC-4626, verified present on the wrapper impl). */
export const STATA_REDEEM_SELECTOR = new Uint8Array([0xba, 0x08, 0x76, 0x52]);

/**
 * Whether the stataToken wrapper is deployed at `evmRpcUrl` (present on Sepolia + a fork of it).
 *
 * @param evmRpcUrl - The EVM JSON-RPC endpoint to probe.
 * @returns True when the stataUSDC wrapper has code at `evmRpcUrl`.
 */
export async function stataAvailable(evmRpcUrl: string): Promise<boolean> {
  const code = await new ethers.JsonRpcProvider(evmRpcUrl).getCode(STATA_USDC);
  return code !== "0x";
}
