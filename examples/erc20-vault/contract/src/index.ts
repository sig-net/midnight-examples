// Curated export surface — this IS the "sdk" face of the package.
// Everything the compiler emitted, plus the handwritten witnesses. Nothing
// here may touch environment-specific APIs: this surface runs unchanged in a
// browser or a backend (deploy tooling lives in ../deploy.ts, outside it).

export * from "./managed/erc20-vault/contract/index.js";
export * from "./witnesses.ts";

// THIS contract's signet ledger layout (declaration order in
// erc20-vault.compact): the SignBidirectionalEventMap at field 0, then the
// rest of the required signet trio (signetSigner, mpcResponseKey), then the
// request counter at field 3. The contract has 15 or fewer ledger fields, so
// each field sits directly in the state tree's root array and every path has
// one entry. A client contract is free to place its event map at any field:
// every raw reader takes the resolved ledger-tree path explicitly, and the
// path must match the `requestsPath` the contract packs into its
// notifications. The compiler records each field's path as its "index" in
// managed/erc20-vault/compiler/contract-info.json.

/**
 * Resolved ledger-tree path of `signBidirectionalEventMap` (ledger field 0).
 * The same path the contract's request circuits pack into their
 * notifications as `requestsPathDepth` 1 + `requestsPath` [0, 0, 0, 0].
 */
export const VAULT_REQUESTS_PATH: readonly number[] = [0];

/** Resolved ledger-tree path of `signetRequestNonce` (ledger field 3). */
export const VAULT_NONCE_PATH: readonly number[] = [3];

/**
 * Resolved ledger-tree path of `swapEventMap` (ledger field 11). Swaps register
 * their notification in this SEPARATE map (sized for a 7-word exactInputSingle),
 * so the swap flow reads MPC responses from this path, not [0]. Matches the
 * `requestsPath` [11, 0, 0, 0] the swap circuit packs into its notification.
 */
export const VAULT_SWAP_REQUESTS_PATH: readonly number[] = [11];
