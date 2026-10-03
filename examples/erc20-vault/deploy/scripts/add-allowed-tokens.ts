// Add-allowed-tokens entrypoint (`yarn add-allowed-tokens:erc20-vault`): the
// deployer allows every ERC20 EVM_ALLOWED_TOKENS lists on the vault named by
// MIDNIGHT_VAULT_CONTRACT_ADDRESS. Tokens the vault already allows are
// skipped, so rerunning with a longer list adds only the new ones.

import { addAllowedTokensToVault } from "../src/add-allowed-tokens.ts";
import { buildEntrypointEnv } from "../src/entrypoint-env.ts";

await addAllowedTokensToVault(buildEntrypointEnv());
