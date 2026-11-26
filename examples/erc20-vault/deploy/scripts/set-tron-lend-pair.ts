// Set-Tron-lend-pair entrypoint (`yarn set-tron-lend-pair:erc20-vault`): the deployer
// pairs TRON_LEND_UNDERLYING with its ERC-4626 TRON_LEND_SHARE_TOKEN, both already listed,
// with TRON_LEND_MIN_SUPPLY (underlying coin units) as the smallest supply, on the vault
// named by MIDNIGHT_VAULT_CONTRACT_ADDRESS. One-shot: a vault already holding the pair is
// left alone.

import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { setTronLendPairOnVault } from "../src/set-tron-lend-pair.ts";

await setTronLendPairOnVault(buildEntrypointEnv());
