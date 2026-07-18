// Curated export surface — this IS the "sdk" face of the package.
// Everything the compiler emitted, plus the handwritten witnesses. Nothing
// here may touch environment-specific APIs: this surface runs unchanged in a
// browser or a backend (deploy tooling lives in ../deploy.ts, outside it).

export * from "./managed/erc20-vault/contract/index.js";
export * from "./witnesses.ts";

// THIS contract's signet ledger layout (declaration order in
// erc20-vault.compact): the request index at field 0, the request counter
// (SignetNonce) at field 1. A signet contract is free to place its index at
// any field — every raw reader takes the position explicitly, and the index
// position must match the `0 as Uint<8>` requestsIndexField the contract
// passes in its notifications.
export const VAULT_REQUESTS_INDEX_FIELD = 0;
export const VAULT_NONCE_FIELD = 1;
