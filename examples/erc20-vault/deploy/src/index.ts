// Public surface of the vault's deploy package: the split deploy, the
// deployer-gated initialise, the environment its entrypoints run against, and
// the Node pieces those flows and the integration tests share: the
// compiled-contract binding over the contract package's managed/ output and
// the midnight-js provider set. The environment-agnostic client surface
// (types, ledger reads, witnesses) lives in the contract package. Every flow
// takes its environment as an argument, so the CLI entrypoints beside this
// directory and the e2e setup pipeline run exactly the same code.
export * from "./deploy-vault.ts";
export * from "./entrypoint-env.ts";
export * from "./evm-targets.ts";
export * from "./initialise-vault.ts";
export * from "./vault-contract-binding.ts";
export * from "./vault-providers.ts";
