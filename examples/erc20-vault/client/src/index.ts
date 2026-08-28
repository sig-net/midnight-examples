// Public surface of the vault's Node runtime client: the compiled-contract
// binding (generated module + witnesses + the compiler output on disk) and the
// midnight-js provider set built around a wallet. The environment-agnostic half
// of the client surface (circuit ids, provider TYPES, ledger reads) lives in
// the contract package; everything here needs Node, which is why it does not.
export * from "./vault-contract-binding.ts";
export * from "./vault-providers.ts";
