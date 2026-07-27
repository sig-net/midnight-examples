// Public surface of @midnight-examples/chain-config — the chain configuration
// primitives shared by Node consumers (deploy scripts, flows, the test
// harness) and browser consumers (an example's ui member).
//
// CRITICAL: this package MUST run unchanged in BOTH runtimes. It is data,
// types and pure functions only: no runtime dependency, no Node builtin, no
// DOM global, and no reading of any environment. Breaking either half is
// SILENT — a bundler stubs a Node builtin instead of failing, and a DOM global
// type-checks here because lib.dom supplies the URL type — so both halves are
// enforced by the split tsconfig and tests/isomorphic.test.ts. Read AGENTS.md
// in this package before adding an import.
//
// Reading configuration OUT of an environment is the consumer's job, since how
// that happens differs per runtime: getMidnightNodeConfig in
// @midnight-examples/lib reads process.env, and a ui member reads
// import.meta.env.
export * from "./network-id.ts";
export * from "./endpoints.ts";
export * from "./evm.ts";
