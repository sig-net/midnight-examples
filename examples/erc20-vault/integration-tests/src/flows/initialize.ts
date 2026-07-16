// `initialize` — the deployer's one-off call sealing the vault's EVM address
// and the EVM chain it operates on into the contract config. Gated in-circuit
// to the deployer identity.

import { asciiPadded, CAIP2_ID_BYTES } from "@sig-net/midnight";

import { evmAddressBytes } from "../evm-transfer.ts";
import type { VaultContext } from "../vault-context.ts";

/** Options for {@link initialize}. */
export interface InitializeOptions {
  /** The vault's EVM address (20-byte 0x hex) to seal into the contract. */
  readonly vaultEvmAddress: string;
}

/**
 * Call the vault's `initialize` circuit on the deployed contract, pinning the
 * vault's EVM address plus the chain it lives on (`EVM_CHAIN_ID`, in both its
 * numeric and CAIP-2 forms) — after this, requests never take a chain
 * argument.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field,
 * so `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this call.
 *
 * @param context - The flow context.
 * @param options - The initialize arguments.
 * @throws If the address is malformed or the circuit rejects the caller.
 */
export async function initialize(context: VaultContext, options: InitializeOptions): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.vaultEvmAddress)) {
    throw new Error(`vaultEvmAddress must be a 20-byte 0x hex address; got "${options.vaultEvmAddress}".`);
  }
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`vault EVM address: ${options.vaultEvmAddress}`);
  console.log(`EVM chain:         ${context.evmChainId} (${context.caip2Id})`);
  console.log(`caller commitment: ${context.identity.commitmentHex} (must equal the sealed deployer)`);

  const result = await context.vault.callTx.initialize(
    evmAddressBytes(options.vaultEvmAddress),
    context.evmChainId,
    asciiPadded(context.caip2Id, CAIP2_ID_BYTES),
  );
  console.log(`initialize finalized in tx ${result.public.txId}`);
}
