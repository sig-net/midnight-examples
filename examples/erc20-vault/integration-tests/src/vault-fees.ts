// The fees a start charges, read from the vault's ledger, so a spec can fund a
// deposit of principal plus fee and assert the fee coin's arrival.

import {
  evmAddressBytes,
  readVaultLedger,
  type TokenFees,
  vaultTokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "./vault-context.ts";

/**
 * The per-action fees the vault holds for an ERC20, read from its current ledger
 * state.
 *
 * @param context - The flow context.
 * @param erc20Address - The ERC20 the vault coin stands for (20-byte 0x hex).
 * @returns That token's fees, in its base units.
 * @throws {Error} If the vault does not allow the ERC20, or no contract answers.
 */
export async function vaultFeesOf(context: VaultContext, erc20Address: string): Promise<TokenFees> {
  return vaultTokenFees(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    evmAddressBytes(erc20Address),
  );
}
