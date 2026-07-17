// Curated export surface — this IS the "sdk" face of the package.
// Everything the compiler emitted, plus the handwritten witnesses. Nothing
// here may touch environment-specific APIs: this surface runs unchanged in a
// browser or a backend (deploy tooling lives in ../deploy.ts, outside it).

export * from "./managed/erc20-vault/contract/index.js";
export * from "./witnesses.ts";
