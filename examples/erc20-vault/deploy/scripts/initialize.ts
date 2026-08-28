// Initialize entrypoint (`yarn initialize:erc20-vault`): run the
// deployer-gated initialize against a vault that already exists, named by
// MIDNIGHT_VAULT_CONTRACT_ADDRESS. This is the recovery half of
// deploy-initialize.ts, for when a deploy succeeded and the initialize did not
// (a missing variable, an interrupted run): the deploy is not repeatable, but
// initialize is one-shot per contract and idempotent, so rerunning is safe.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { initializeVault } from "../src/initialize-vault.ts";

await initializeVault(buildEntrypointEnv());
