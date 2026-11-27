// Deploy + initialise entrypoint (`yarn deploy-initialise:erc20-vault`): the
// one-shot bring-up of a vault on a REMOTE network, where no test pipeline runs
// the steps for you: deploy, initialise, then allow the ERC20s
// EVM_ALLOWED_TOKENS lists. Every step is the same function the e2e setup and
// the flow tests exercise locally, so the multistage deploy this performs is
// continuously tested. Prints the address to set as
// NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS in the frontend.
//
// A deployed network REQUIRES a kept MAINTENANCE_SIGNING_KEY (the sealed
// authority that installs the deferred circuits, and the only way to add or
// replace one later) and a faucet-funded DEPLOYER_SEED.

import { getDeployConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

import { addAllowedTokensToVault } from "../src/add-allowed-tokens.ts";
import { deployVault } from "../src/deploy-vault.ts";
import { logDeployerFundingAddress } from "../src/deployer-run-report.ts";
import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { resolveAllowedTokens } from "../src/evm-targets.ts";
import {
  assertInitialiseInputsPresent,
  assertNoVaultBoundPresets,
  initialiseVault,
} from "../src/initialise-vault.ts";

const env = buildEntrypointEnv();

// Before spending a whole multistage deploy: a missing chain id, a malformed
// router override or allowed token, or a leftover previous vault's values must
// fail now, not after the contract exists.
await assertInitialiseInputsPresent(env);
resolveAllowedTokens(env);
assertNoVaultBoundPresets(env);

// One registry for the whole run, so the deployer wallet syncs once and the
// later steps only catch it up.
const deployConfig = getDeployConfig(env);
logDeployerFundingAddress(deployConfig);
const wallets = new WalletRegistry(deployConfig.midnightNodeConfig, env);
let contractAddress: string;
try {
  ({ contractAddress } = await deployVault(env, wallets));
  await initialiseVault(env, contractAddress, wallets);
  await addAllowedTokensToVault(env, contractAddress, wallets);
} finally {
  await wallets.close();
}

console.log("\n==================== DONE ====================");
console.log(`NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
console.log("================================================");
