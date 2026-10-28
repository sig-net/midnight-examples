// Set-token-fees entrypoint (`yarn set-token-fees:erc20-vault`): the deployer
// reprices each ERC20 VAULT_TOKEN_FEES names, on the vault named by
// MIDNIGHT_VAULT_CONTRACT_ADDRESS, to the fees the map gives in that token's
// base units. The call a scheduled repricing job makes: it computes each
// token's fees from current gas and token prices, exports the map, and runs
// this. Tokens already at their fees are skipped.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { setTokenFeesOnVault } from "../src/set-token-fees.ts";

await setTokenFeesOnVault(buildEntrypointEnv());
