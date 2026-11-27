// Set-gas-params entrypoint (`yarn set-gas-params:erc20-vault`): the deployer
// resets the gas settings of the vault named by MIDNIGHT_VAULT_CONTRACT_ADDRESS.
// Each of VAULT_MAX_FEE_PER_GAS, VAULT_MAX_PRIORITY_FEE_PER_GAS and the five
// VAULT_GAS_LIMIT_* variables replaces one setting, and an unset one keeps the
// vault's current value.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { setGasParamsOnVault } from "../src/set-gas-params.ts";

await setGasParamsOnVault(buildEntrypointEnv());
