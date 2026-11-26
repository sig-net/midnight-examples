// Set-Tron-token-fees entrypoint (`yarn set-tron-token-fees:erc20-vault`): the deployer
// reprices each TRC-20 TRON_ALLOWED_TOKENS lists that VAULT_TOKEN_FEES prices, on the vault
// named by MIDNIGHT_VAULT_CONTRACT_ADDRESS, to the fees the map gives in that token's coin
// units. Each token keeps its factor, and tokens already at their fees are skipped.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { setTronTokenFeesOnVault } from "../src/set-token-fees.ts";

await setTronTokenFeesOnVault(buildEntrypointEnv());
