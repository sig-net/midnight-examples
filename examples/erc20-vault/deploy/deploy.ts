// Deploy entrypoint (`yarn deploy:erc20-vault`): a thin shell over
// src/deploy-vault.ts, so the e2e setup pipeline runs the same split deploy
// in-process by importing that function directly.

import { deployVault } from "./src/deploy-vault.ts";
import { buildEntrypointEnv } from "./src/entrypoint-env.ts";

await deployVault(buildEntrypointEnv());
