// Initialise entrypoint (`yarn initialise:erc20-vault`): run the
// deployer-gated initialise against a vault that already exists, named by
// MIDNIGHT_VAULT_CONTRACT_ADDRESS. This is the recovery half of
// deploy-initialise.ts, for when a deploy succeeded and the initialise did not
// (a missing variable, an interrupted run): the deploy is not repeatable, but
// initialise is one-shot per contract and idempotent, so rerunning is safe.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { initialiseVault } from "../src/initialise-vault.ts";

await initialiseVault(buildEntrypointEnv());
