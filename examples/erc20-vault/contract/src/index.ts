// Curated export surface: the "sdk" face of the package.
// Everything the compiler emitted, the handwritten witnesses, the typed client
// surface, the ledger reads, the contract's EVM-side constants and the
// published per-network vault addresses. Nothing here
// may touch environment-specific APIs: this surface runs unchanged in a browser
// or a backend. Anything that cannot (the Node compiled-contract binding, a
// live provider set, deploy tooling) lives in a sibling package.

import { asciiPadded, bytesToHex, deriveEvmAddress, PATH_BYTES } from "@sig-net/midnight";

export * from "./contract-surface.ts";
export * from "./evm.ts";
export * from "./managed/erc20-vault/contract/index.js";
export * from "./vault-addresses.ts";
export * from "./vault-ledger.ts";
export * from "./vault-queue.ts";
export * from "./witnesses.ts";

/**
 * The vault's own derivation path as the ledger stores it: every circuit that
 * records a vault-signed event sets the record's `path` to `pad(32, "vault")`.
 */
export const VAULT_PATH_BYTES = asciiPadded("vault", PATH_BYTES);

/**
 * The derivation-string rendering of {@link VAULT_PATH_BYTES}: the MPC renders
 * a record's path as the lowercase hex of the full 32 bytes, padding included,
 * and `deriveEvmAddress` takes the same rendering. Deriving the vault's EVM
 * account with any other rendering of "vault" yields an account the MPC will
 * never sign from.
 */
export const VAULT_PATH_HEX = bytesToHex(VAULT_PATH_BYTES);

/**
 * Derive the EVM account the MPC signs the vault's transactions from:
 * `f(MPC public key, this vault's contract address, {@link VAULT_PATH_HEX})`.
 * The one definition of that derivation, so the address a deploy seals in and
 * the address a test funds cannot drift apart.
 *
 * @param mpcSecp256k1PublicKey - The MPC network's secp256k1 public key (SEC1 hex).
 * @param vaultContractAddress - The deployed vault contract's address.
 * @returns The vault's EVM address, 0x-prefixed.
 */
export function deriveVaultEvmAddress(
  mpcSecp256k1PublicKey: string,
  vaultContractAddress: string,
): string {
  return deriveEvmAddress(mpcSecp256k1PublicKey, vaultContractAddress, VAULT_PATH_HEX);
}

// THIS contract's signet ledger layout: each action owns a
// SignBidirectionalEventMapV1. A client contract is free to place its event maps
// at any field: every raw reader takes the resolved ledger-tree path explicitly,
// and the path must match the `requestsPath` the contract packs into its
// notifications. The compiler records each field's path as its "index" in
// managed/erc20-vault/compiler/contract-info.json. The vault has more than 15
// ledger fields, so the compiler chunks the state tree two levels deep and every
// path is [chunk, offset] (depth 2).

/**
 * Resolved ledger-tree path of `bidirectionalDepositMap`, which holds the deposit
 * requests, as the compiled `contract-info.json` lists it. Matches the depth 2 +
 * `requestsPath` [2, 5, 0, 0] the `sendDeposit` circuit packs.
 */
export const VAULT_DEPOSIT_REQUESTS_PATH: readonly number[] = [2, 5];

/**
 * Resolved ledger-tree path of `bidirectionalWithdrawMap`, which holds the withdraw
 * requests, as the compiled `contract-info.json` lists it. Matches the depth 2 +
 * `requestsPath` [2, 7, 0, 0] the `sendWithdraw` circuit packs.
 */
export const VAULT_WITHDRAW_REQUESTS_PATH: readonly number[] = [2, 7];

/**
 * Resolved ledger-tree path of `bidirectionalApproveMap`, which holds the approve
 * requests of both spenders (the Uniswap router and the stataToken wrapper), as the
 * compiled `contract-info.json` lists it. Matches the depth 2 + `requestsPath`
 * [2, 3, 0, 0] the `sendApprove` circuit packs.
 */
export const VAULT_APPROVE_REQUESTS_PATH: readonly number[] = [2, 3];

/**
 * Resolved ledger-tree path of `bidirectionalReplaceNonceMap`, which holds the nonce
 * replacement requests, as the compiled `contract-info.json` lists it. Matches the
 * depth 2 + `requestsPath` [2, 1, 0, 0] the `sendReplaceNonce` circuit packs.
 */
export const VAULT_REPLACE_NONCE_REQUESTS_PATH: readonly number[] = [2, 1];

/**
 * Resolved ledger-tree path of `bidirectionalSwapMap`, which holds the swap requests,
 * as the compiled `contract-info.json` lists it. Matches the depth 2 + `requestsPath`
 * [2, 9, 0, 0] the `sendSwap` circuit packs.
 */
export const VAULT_SWAP_REQUESTS_PATH: readonly number[] = [2, 9];

/**
 * Resolved ledger-tree path of `bidirectionalSupplyMap`, which holds the supply
 * requests, as the compiled `contract-info.json` lists it. Matches the depth 2 +
 * `requestsPath` [2, 11, 0, 0] the `sendSupply` circuit packs.
 */
export const VAULT_SUPPLY_REQUESTS_PATH: readonly number[] = [2, 11];

/**
 * Resolved ledger-tree path of `bidirectionalRedeemMap`, which holds the redeem
 * requests, as the compiled `contract-info.json` lists it. Matches the depth 2 +
 * `requestsPath` [2, 13, 0, 0] the `sendRedeem` circuit packs.
 */
export const VAULT_REDEEM_REQUESTS_PATH: readonly number[] = [2, 13];
