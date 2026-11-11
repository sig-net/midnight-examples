import { addAllowedTronTokensToVault } from "../src/add-allowed-tron-tokens.ts";
import { buildEntrypointEnv } from "../src/entrypoint-env.ts";

await addAllowedTronTokensToVault(buildEntrypointEnv());
