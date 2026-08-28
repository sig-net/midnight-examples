// Curated export surface: the "sdk" face of the package.
// Everything the compiler emitted, the handwritten witnesses, the typed client
// surface, the ledger reads and the contract's EVM-side constants. Nothing here
// may touch environment-specific APIs: this surface runs unchanged in a browser
// or a backend. Anything that cannot (the Node compiled-contract binding, a
// live provider set, deploy tooling) lives in a sibling package.

import { asciiPadded, bytesToHex, PATH_BYTES } from "@sig-net/midnight";

export * from "./contract-surface.ts";
export * from "./evm.ts";
export * from "./managed/erc20-vault/contract/index.js";
export * from "./vault-ledger.ts";
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

// THIS contract's signet ledger layout (declaration order in
// erc20-vault.compact): the SignBidirectionalEventMap at field 0, then the
// rest of the required signet trio (signetSigner, mpcResponseKey), then the
// request counter at field 3. A client contract is free to place its event map
// at any field:
// every raw reader takes the resolved ledger-tree path explicitly, and the
// path must match the `requestsPath` the contract packs into its
// notifications. The compiler records each field's path as its "index" in
// managed/erc20-vault/compiler/contract-info.json.

// The vault has 19 ledger fields, past the 15-field flat limit, so the compiler
// chunks the state tree two levels deep. Every path below is therefore
// [chunk, offset] (depth 2), and the request circuits pack the same as
// requestsPathDepth 2. Chunk 0 holds fields 0-3, chunk 1 holds fields 4-18.

/**
 * Resolved ledger-tree path of `signBidirectionalEventMap` (ledger field 0).
 * The same path the contract's request circuits pack as depth 2 + [0, 0, 0, 0].
 */
export const VAULT_REQUESTS_PATH: readonly number[] = [0, 0];

/** Resolved ledger-tree path of `signetRequestNonce` (ledger field 3). */
export const VAULT_NONCE_PATH: readonly number[] = [0, 3];

/**
 * Resolved ledger-tree path of `swapEventMap` (ledger field 11). Swaps register
 * their notification in this SEPARATE map (sized for a 7-word exactOutputSingle),
 * so the swap flow reads MPC responses from this path. Matches the depth 2 +
 * `requestsPath` [1, 7, 0, 0] the swap circuit packs.
 */
export const VAULT_SWAP_REQUESTS_PATH: readonly number[] = [1, 7];

/** Resolved ledger-tree path of `supplyEventMap` (ledger field 15). */
export const VAULT_SUPPLY_REQUESTS_PATH: readonly number[] = [1, 11];

/** Resolved ledger-tree path of `redeemEventMap` (ledger field 17). */
export const VAULT_REDEEM_REQUESTS_PATH: readonly number[] = [1, 13];
