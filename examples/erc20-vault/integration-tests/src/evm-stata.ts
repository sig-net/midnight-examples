// Aave ERC-4626 (stataToken) constants for the supply/redeem flows: the pinned Aave USDC
// pair on Sepolia, the deposit/redeem/approve ABI shapes, the supply/redeem schemas, and the
// contract-fixed routing. Mirrors evm-swap.ts for the lending leg.
import {
  asciiPadded,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
} from "@sig-net/midnight";
import { pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";
import { STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { ethers } from "ethers";

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

/** MPC decodes deposit's uint256 shares return against this (byte-matches supplyOutputSchema, 36). */
export const SUPPLY_OUTPUT_SCHEMA = '[{"name":"shares","type":"uint256"}]';
/** MPC re-packs the decoded shares into a uint64 (byte-matches supplyRespondSchema, 35). */
export const SUPPLY_RESPOND_SCHEMA = '[{"name":"shares","type":"uint64"}]';
/** MPC decodes redeem's uint256 assets return against this (byte-matches redeemOutputSchema, 36). */
export const REDEEM_OUTPUT_SCHEMA = '[{"name":"assets","type":"uint256"}]';
/** MPC re-packs the decoded assets into a uint64 (byte-matches redeemRespondSchema, 35). */
export const REDEEM_RESPOND_SCHEMA = '[{"name":"assets","type":"uint64"}]';

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
  outputDeserializationSchema: asciiPadded(SUPPLY_OUTPUT_SCHEMA, SUPPLY_OUTPUT_SCHEMA.length),
  respondSerializationSchema: asciiPadded(SUPPLY_RESPOND_SCHEMA, SUPPLY_RESPOND_SCHEMA.length),
};

/** Contract-fixed routing of a redeem event. */
export const REDEEM_MPC_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(REDEEM_OUTPUT_SCHEMA, REDEEM_OUTPUT_SCHEMA.length),
  respondSerializationSchema: asciiPadded(REDEEM_RESPOND_SCHEMA, REDEEM_RESPOND_SCHEMA.length),
};
