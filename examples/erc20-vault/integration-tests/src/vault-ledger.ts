// Shared vault ledger reads: raw contract state from a public data provider,
// decoded with the generated `ledger()`. Takes the provider + address rather
// than a full VaultContext so the read-state script can drive it without a
// wallet.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { bytesToHex, toSignBidirectionalRequestIndex } from "@sig-net/midnight";
import { ledger } from "@midnight-examples/erc20-vault-contract";

/** The decoded vault public ledger state, as the generated `ledger()` returns it. */
export type VaultLedgerState = ReturnType<typeof ledger>;

/**
 * Read + decode the vault's public ledger state.
 *
 * @param publicDataProvider - The provider to query raw contract state through.
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The decoded ledger state.
 * @throws If no contract state exists at `vaultContractAddress`.
 */
export async function readVaultLedger(
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
): Promise<VaultLedgerState> {
  const contractState = await publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }
  return ledger(contractState.data);
}

/**
 * Read and print the vault's public ledger state: initialization status, the
 * configured vault EVM address, the pinned EVM chain, and the pending signet
 * signature requests. No proving keys or transactions involved.
 *
 * @param publicDataProvider - The provider to query raw contract state through.
 * @param vaultContractAddress - The deployed vault contract address.
 * @throws If no contract state exists at `vaultContractAddress`.
 */
export async function printVaultState(
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
): Promise<void> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`initialized:       ${state.initialized}`);
  console.log(`vault EVM address: 0x${bytesToHex(state.vaultEvmAddress)}`);
  // caip2Id is zero-padded ASCII; NUL-trim for display.
  console.log(`EVM chain:         ${state.evmChainId} (${new TextDecoder().decode(state.caip2Id).replace(/\0+$/u, "")})`);

  const index = toSignBidirectionalRequestIndex(state.signetRequestsIndex);
  console.log(`pending signature requests: ${index.size}`);
  for (const [requestIdHex, request] of index) {
    console.log(`- ${requestIdHex} (requestNonce ${request.requestNonce})`);
  }
}
