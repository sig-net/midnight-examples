// Aave ERC-4626 (stataToken) constants for the supply/redeem flows: the pinned Aave USDC
// pair on Sepolia, the deposit/redeem/approve ABI shapes, the supply/redeem schemas, and the
// contract-fixed routing. Mirrors evm-swap.ts for the lending leg.
import { pureCircuits } from "@midnight-examples/erc20-vault-contract";
import { MPC_PARAMS_BYTES, MPCDestination, MPCSignatureAlgorithm } from "@sig-net/midnight";
import { ethers } from "ethers";

/** Aave v3 Sepolia USDC: the underlying the vault lends (initialise's stataUnderlying). */
export const AAVE_USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";

/** Aave v3 Sepolia stataUSDC: the non-rebasing ERC-4626 wrapper (a proxy). */
export const STATA_USDC = "0x8A88124522dbBF1E56352ba3DE1d9F78C143751e";

/** deposit(uint256,address) selector (ERC-4626, verified present on the wrapper impl). */
export const STATA_DEPOSIT_SELECTOR = new Uint8Array([0x6e, 0x55, 0x3f, 0x65]);

/** redeem(uint256,address,address) selector (ERC-4626, verified present on the wrapper impl). */
export const STATA_REDEEM_SELECTOR = new Uint8Array([0xba, 0x08, 0x76, 0x52]);

/** approve(address,uint256) selector (approveStata grants the wrapper an allowance on USDC). */
export const APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);

/** The allowance approveStata grants, read from the compiled circuit so it cannot drift. */
export const MAX_APPROVE = pureCircuits.unlimitedAllowance();

/** Gas ceiling of a supply/redeem through the ERC-4626 wrapper; the contract fixes it (vault pays). */
export const STATA_GAS_LIMIT = 500_000n;

/** Max total fee per gas, wei (30 gwei). */
export const STATA_MAX_FEE_PER_GAS = 30_000_000_000n;

/** Max priority fee per gas, wei (1 gwei). */
export const STATA_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

/** MPC decodes deposit's uint256 shares return against this, read from the compiled circuit. */
export const SUPPLY_OUTPUT_SCHEMA = pureCircuits.supplyOutputSchema();
/** MPC re-packs the decoded shares into a uint64, read from the compiled circuit. */
export const SUPPLY_RESPOND_SCHEMA = pureCircuits.supplyRespondSchema();
/** MPC decodes redeem's uint256 assets return against this, read from the compiled circuit. */
export const REDEEM_OUTPUT_SCHEMA = pureCircuits.redeemOutputSchema();
/** MPC re-packs the decoded assets into a uint64, read from the compiled circuit. */
export const REDEEM_RESPOND_SCHEMA = pureCircuits.redeemRespondSchema();

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

/** Contract-fixed routing of a supply event (the supply-schema variant of VAULT_MPC_ROUTING). */
export const SUPPLY_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: SUPPLY_OUTPUT_SCHEMA,
  respondSerializationSchema: SUPPLY_RESPOND_SCHEMA,
};

/** Contract-fixed routing of a redeem event. */
export const REDEEM_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: REDEEM_OUTPUT_SCHEMA,
  respondSerializationSchema: REDEEM_RESPOND_SCHEMA,
};
