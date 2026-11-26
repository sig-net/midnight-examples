// The vault's shielded token color, computed the sanctioned way: the
// contract's compiled `vaultTokenDomainSeparator` circuit, or for a TRC-20 the
// colour its listing stores (`tronCoinColour(token, factor)`), plus the
// runtime's `rawTokenType` (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`) — never a TS re-implementation.
// Shared by the start flows (a surrendered coin's color) and by tests that
// read a wallet's shielded balance of the vault token.

import {
  type ContractAddress,
  type RawTokenType,
  rawTokenType,
} from "@midnight-ntwrk/compact-runtime";
import {
  type AllowedTronTokenConfig,
  evmAddressBytes,
  pureCircuits,
} from "@sig-net/midnight-examples-erc20-vault-contract";

/**
 * Compute the shielded token color the vault at `vaultContractAddress` mints
 * for `erc20Address` — the key coins of this token carry in ledger state and
 * wallet balance maps.
 *
 * @param erc20Address - The ERC20 token contract on the target chain (20-byte 0x hex).
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The raw token type (hex) of the vault token for this ERC20.
 * @throws {Error} If `erc20Address` is not a 20-byte 0x hex string.
 */
export function vaultTokenType(
  erc20Address: string,
  vaultContractAddress: ContractAddress,
): RawTokenType {
  return rawTokenType(
    pureCircuits.vaultTokenDomainSeparator(evmAddressBytes(erc20Address)),
    vaultContractAddress,
  );
}

/**
 * Compute the shielded token color the vault at `vaultContractAddress` mints for a TRC-20:
 * the colour its listing stores, which `tronCoinColour(token, factor)` fixed at listing.
 *
 * @param config - The TRC-20's listing, from `vaultTronTokenConfig`.
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The raw token type (hex) of the vault token for this TRC-20.
 */
export function vaultTronTokenType(
  config: AllowedTronTokenConfig,
  vaultContractAddress: ContractAddress,
): RawTokenType {
  return rawTokenType(config.colour, vaultContractAddress);
}
