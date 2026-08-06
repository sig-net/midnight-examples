// The stand-the-stack-up spec: selecting just this file runs the full
// globalSetup pipeline (compile, deploy, fund, persist, print), initializes
// the vault, and asserts the pipeline delivered what the UI demo needs,
// without driving any deposit or withdrawal. This is the fastest way to get
// the local stack's contracts up for the UI:
//   yarn test:erc20-vault:e2e tests/deploy-only.test.ts
// Reruns are cheap: every pipeline step skips when its value is already in
// the repo-root .env, and an already-initialized vault skips the initialize.

import { afterAll, describe, expect, it } from "vitest";
import { loadRepoDotEnv, logSkip, requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";

import { initialize } from "../src/flows/initialize.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + vault context, lazily built so the offline path never
// touches the network; stopped once in afterAll.
const session = createVaultSession(env);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault deploy-only", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it("the pipeline produced every value the UI demo needs", () => {
    for (const key of [
      "USER_SEED",
      "MPC_SECP256K1_PUBKEY",
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
      "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
      "ERC20_ADDRESS",
      "EVM_SEED_WALLET_ADDRESS",
    ]) {
      expect(env[key], key).toBeTruthy();
    }
  });

  it("the copy-paste values are in the repo-root .env", () => {
    const fileEnv = loadRepoDotEnv();
    // The seed the demo's wallets install from, the two values the ui's
    // .env.local mirrors, and the token its tracked-tokens field takes: a
    // user reads them out of .env, never out of this run's log.
    expect(fileEnv.USER_SEED, "USER_SEED").toBeTruthy();
    expect(fileEnv.MPC_SECP256K1_PUBKEY).toBe(env.MPC_SECP256K1_PUBKEY);
    expect(fileEnv.MIDNIGHT_VAULT_CONTRACT_ADDRESS).toBe(env.MIDNIGHT_VAULT_CONTRACT_ADDRESS);
    expect(fileEnv.ERC20_ADDRESS).toBe(env.ERC20_ADDRESS);
  });

  it(
    "initialize [erc-vault contract method call]: the vault is initialized, so its ledger names its EVM account",
    async () => {
      const context = await session.vaultContext();
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

      if ((await readLedger()).initialized) {
        logSkip("initialize", "vault is already initialized (rerun against a kept contract address)");
      } else {
        await initialize(context, {
          vaultEvmAddress: requireEnv("EVM_VAULT_ADDRESS"),
          mpcResponseKey: requireEnv("MPC_RESPONSE_KEY"),
        });
      }

      expect((await readLedger()).initialized).toBe(1n);
    },
    15 * MINUTE,
  );
});
