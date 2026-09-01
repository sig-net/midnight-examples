// Deploy + initialise entrypoint (`yarn deploy-initialise:erc20-vault`): the
// one-shot bring-up of a vault on a REMOTE network, where no test pipeline runs
// the two halves for you. Both halves are the same functions the e2e setup and
// the flow tests exercise locally, so the multistage deploy this performs is
// continuously tested. Prints the address to set as
// NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS in the frontend.
//
// A deployed network REQUIRES a kept MIDNIGHT_MAINTENANCE_PRIVATE_KEY (the sealed
// authority that installs the deferred circuits, and the only way to add or
// replace one later) and a faucet-funded MIDNIGHT_DEPLOYER_WALLET_SEED.

import { deployVault } from "../src/deploy-vault.ts";
import { buildEntrypointEnv } from "../src/entrypoint-env.ts";
import { assertInitialiseInputsPresent, initialiseVault } from "../src/initialise-vault.ts";

const env = buildEntrypointEnv();

// Before spending a whole multistage deploy: a missing chain id or a malformed
// router override must fail now, not after the contract exists.
assertInitialiseInputsPresent(env);

const { contractAddress } = await deployVault(env);
await initialiseVault(env, contractAddress);

console.log("\n==================== DONE ====================");
console.log(`NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
console.log("================================================");
