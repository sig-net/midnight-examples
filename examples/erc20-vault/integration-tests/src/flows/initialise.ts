// `initialise`: the deployer's one-off call sealing the vault's post-deploy
// configuration into the contract, i.e. the vault's EVM address, the EVM
// chain it operates on, and the MPC RESPONSE key (derived from the vault's
// own contract address, so it cannot be a constructor argument). Gated
// in-circuit to the deployer identity.

import { asciiPadded, CAIP2_ID_BYTES, parseSecp256k1PublicKey } from "@sig-net/midnight";

import { AAVE_USDC, STATA_USDC } from "../evm-stata.ts";
import { UNISWAP_SWAP_ROUTER_02 } from "../evm-swap.ts";
import { evmAddressBytes } from "../evm-transfer.ts";
import type { VaultContext } from "../vault-context.ts";

/** Options for {@link initialise}. */
export interface InitialiseOptions {
  /** The vault's EVM address (20-byte 0x hex) to seal into the contract. */
  readonly vaultEvmAddress: string;
  /** The Uniswap SwapRouter02 to pin; defaults to the Sepolia canonical. */
  readonly routerAddress?: string;
  /** The Aave underlying (USDC) to pin; defaults to the Sepolia Aave USDC. */
  readonly stataUnderlyingAddress?: string;
  /** The stataToken (stataUSDC) wrapper to pin; defaults to the Sepolia stataUSDC. */
  readonly stataTokenAddress?: string;
  /**
   * The MPC response key for THIS vault contract (SEC1 hex, compressed or
   * uncompressed): `f(MPC root key, vault contract address, "midnight
   * response key")`, the setup pipeline's `MPC_RESPONSE_KEY`. Every settle and
   * refund circuit (the five `complete*` and the four `refund*`) accepts only
   * responses ECDSA-signed by it.
   */
  readonly mpcResponseKey: string;
}

/**
 * Call the vault's `initialise` circuit on the deployed contract, pinning the
 * vault's EVM address, the chain it lives on (`EVM_CHAIN_ID`, in both its
 * numeric and CAIP-2 forms) and the MPC response key. After this, requests
 * never take a chain argument and responses verify against the stored key.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field,
 * so `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this call.
 *
 * @param context - The flow context.
 * @param options - The initialise arguments.
 * @throws {Error} If an argument is malformed or the circuit rejects the caller.
 */
export async function initialise(context: VaultContext, options: InitialiseOptions): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.vaultEvmAddress)) {
    throw new Error(
      `vaultEvmAddress must be a 20-byte 0x hex address; got "${options.vaultEvmAddress}".`,
    );
  }
  console.log(`vault contract:    ${context.vaultContractAddress}`);
  console.log(`vault EVM address: ${options.vaultEvmAddress}`);
  console.log(`EVM chain:         ${String(context.evmChainId)} (${context.caip2Id})`);
  console.log(`MPC response key:  ${options.mpcResponseKey}`);
  console.log(
    `caller commitment: ${context.identity.commitmentHex} (must equal the sealed deployer)`,
  );

  const result = await context.vault.callTx.initialise(
    evmAddressBytes(options.vaultEvmAddress),
    evmAddressBytes(options.routerAddress ?? UNISWAP_SWAP_ROUTER_02),
    evmAddressBytes(options.stataUnderlyingAddress ?? AAVE_USDC),
    evmAddressBytes(options.stataTokenAddress ?? STATA_USDC),
    context.evmChainId,
    asciiPadded(context.caip2Id, CAIP2_ID_BYTES),
    parseSecp256k1PublicKey(options.mpcResponseKey),
  );
  console.log(`initialise finalized in tx ${result.public.txId}`);
}
