// EVM chain configuration primitives.
//
// Unlike the Midnight side, these are this repository's own names with no SDK
// counterpart to mirror, so each carries an explicit `Evm`/`EVM_` marker: the
// package's exports are flat, and a bare `LOCAL_CHAIN` at a call site would
// not say which chain it meant.
export * from "./chain.ts";
