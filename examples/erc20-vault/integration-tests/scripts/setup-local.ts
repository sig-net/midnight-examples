// Local bring-up entrypoint (`yarn setup-local:erc20-vault`): deploy and
// initialise a vault on the local docker stack from a `.env` holding only
// SEPOLIA_FORK_RPC_URL, and persist every value the run generated to that
// same `.env` under the names the e2e suite reads, so `yarn
// test:erc20-vault:e2e` (or a hand-driven flow) reuses the stack with every
// setup step skipping. The steps are the suite's own `vaultSetupSteps()`, run
// in-process exactly as vitest's globalSetup runs them, followed by the
// deploy package's `initialiseVault`, the same function the remote
// `deploy-initialise` entrypoint runs. Rerunnable: a kept address resumes or
// skips, an initialised vault is left untouched, and a value already in
// `.env` with the run's value is not appended again.

import { initialiseVault } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import {
  banner,
  persistToDotEnv,
  runSetupSteps,
  testHeader,
} from "@sig-net/midnight-examples-test-harness";

import { VAULT_PIPELINE_KEYS, vaultSetupSteps } from "../src/setup.ts";

const env = await runSetupSteps(buildBaseEnv(), vaultSetupSteps());

testHeader(1, 2, "initialise: seal the vault's EVM address, chain and MPC response key");
const outcome = await initialiseVault(env);
console.log(`initialise outcome: ${outcome}`);

testHeader(2, 2, "persist: append the generated values to .env");
const appended = persistToDotEnv(
  env,
  VAULT_PIPELINE_KEYS,
  `appended by the erc20-vault local setup (${new Date().toISOString()})`,
);
banner([
  appended.length === 0
    ? "Every generated value was already in .env: nothing appended."
    : `Appended to .env: ${appended.join(", ")}`,
  "",
  "The local stack is ready. Next:",
  "  yarn test:erc20-vault:e2e     # reuses this stack, every setup step skips",
  "  yarn workspace @sig-net/midnight-examples-erc20-vault-integration-tests read-state",
]);
