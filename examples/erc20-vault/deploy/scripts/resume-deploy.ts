// Resume entrypoint (`yarn resume-deploy:erc20-vault`): install the circuits a
// split deploy left missing on a vault that already exists, named by
// MIDNIGHT_VAULT_CONTRACT_ADDRESS. This is the recovery for a run that died
// AFTER its base deploy was submitted (the log shows the base-submitted marker
// and the address): rerunning the deploy would create a second contract, so
// this finishes the first one instead. Then run `yarn initialise:erc20-vault`.

import { resumeVaultDeploy } from "../src/deploy-vault.ts";
import { buildEntrypointEnv } from "../src/entrypoint-env.ts";

await resumeVaultDeploy(buildEntrypointEnv());
