import {
  type FlushItems,
  flushUntil as flushUntilOn,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Flushes, carrying `first` ahead of every other waiting item, until `flushed` holds
 * for the vault's ledger.
 *
 * @param context - The vault context.
 * @param flushed - Whether the ledger shows what the caller waits for.
 * @param first - The items the caller waits for.
 * @returns The ledger state that satisfied `flushed`.
 */
export function flushUntil(
  context: VaultContext,
  flushed: (state: VaultLedgerState) => boolean,
  first: FlushItems,
): Promise<VaultLedgerState> {
  return flushUntilOn(
    context.providers,
    vaultCompiledContract,
    context.vaultContractAddress,
    flushed,
    first,
  );
}
