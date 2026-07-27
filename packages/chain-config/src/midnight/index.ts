// Midnight's chain configuration primitives.
//
// These names deliberately match `@sig-net/midnight-contract-deploy`'s
// `plumbing/` exports verbatim, unprefixed. This package exists only until the
// client-agnostic SDK publishes browser-safe equivalents, and matching names
// keep that swap a change of import path rather than a rename. The `midnight/`
// directory is what tells a reader which chain they belong to.
export * from "./networks.ts";
export * from "./endpoints.ts";
