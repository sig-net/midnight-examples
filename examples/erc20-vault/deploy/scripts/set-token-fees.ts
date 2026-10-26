// Set-token-fees entrypoint (`yarn set-token-fees:erc20-vault`): the deployer
// reprices every ERC20 the vault named by MIDNIGHT_VAULT_CONTRACT_ADDRESS
// allows to the VAULT_FEE_* values. The call a scheduled repricing job makes:
// it computes the fees from current gas and token prices, exports them, and
// runs this. Tokens already at those fees are skipped.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { setTokenFeesOnVault } from "../src/set-token-fees.ts";

await setTokenFeesOnVault(buildEntrypointEnv());
