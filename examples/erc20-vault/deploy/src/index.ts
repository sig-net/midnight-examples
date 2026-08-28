// Public surface of the vault's deploy package: the split deploy, the
// deployer-gated initialize, and the environment its entrypoints run against.
// Nothing else belongs here. The contract binding, the provider set and the
// ledger reads are client/SDK surface and live in the sibling client and
// contract packages. Every flow takes its environment as an argument, so the
// CLI entrypoints beside this directory and the e2e setup pipeline run exactly
// the same code.
export * from "./deploy-vault.ts";
export * from "./entrypoint-env.ts";
export * from "./evm-targets.ts";
export * from "./initialize-vault.ts";
