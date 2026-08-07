// The stand-the-stack-up spec: selecting just this file runs the full
// globalSetup pipeline (compile, deploy, fund, persist, print), initializes
// the vault, and asserts the pipeline delivered what the UI demo needs,
// without driving any deposit or withdrawal. This is the fastest way to get
// the local stack's contracts up for the UI:
//   yarn test:erc20-vault:e2e tests/deploy-only.test.ts
// Reruns are cheap: every pipeline step skips when its value is already in
// the repo-root .env, and an already-initialized vault skips the initialize.

import {
  loadRepoDotEnv,
  logSkip,
  requireEnv as requireEnvOf,
} from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

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

// The deployer's session, for initialize only: the circuit is gated to the
// deployer identity (the deployer wallet seed's bytes, whose commitment the
// deploy sealed), so the user session cannot drive it. Lazily built like
// every session — a rerun against an initialized vault never starts it.
const deployerSession = createVaultSession({
  ...env,
  MIDNIGHT_USER1_WALLET_SEED: env.MIDNIGHT_DEPLOYER_WALLET_SEED ?? "",
});

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault deploy-only", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
    await deployerSession.stop();
  });

  it("the pipeline produced every value the UI demo needs", () => {
    for (const key of [
      "MIDNIGHT_USER1_WALLET_SEED",
      "EVM_USER1_WALLET_SEED",
      "MPC_ROOT_PUBLIC_KEY",
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
      "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
      "EVM_ERC20_CONTRACT_ADDRESS",
      "EVM_USER1_WALLET_ADDRESS",
    ]) {
      expect(env[key], `the setup pipeline did not populate ${key}`).toBeTruthy();
    }
  });

  it("the copy-paste values are in the repo-root .env", () => {
    const fileEnv = loadRepoDotEnv();
    // The two seeds the demo's wallets install from (one per chain), the two
    // values the ui's .env.local mirrors, and the token its tracked-tokens
    // field takes: a user reads them out of .env, never out of this run's log.
    expect(fileEnv.MIDNIGHT_USER1_WALLET_SEED, "MIDNIGHT_USER1_WALLET_SEED").toBeTruthy();
    expect(fileEnv.EVM_USER1_WALLET_SEED).toBe(env.EVM_USER1_WALLET_SEED);
    expect(fileEnv.MPC_ROOT_PUBLIC_KEY).toBe(env.MPC_ROOT_PUBLIC_KEY);
    expect(fileEnv.MIDNIGHT_VAULT_CONTRACT_ADDRESS).toBe(env.MIDNIGHT_VAULT_CONTRACT_ADDRESS);
    expect(fileEnv.EVM_ERC20_CONTRACT_ADDRESS).toBe(env.EVM_ERC20_CONTRACT_ADDRESS);
  });

  it(
    "initialize [erc-vault contract method call]: the vault is initialized, so its ledger names its EVM account",
    async () => {
      const context = await session.vaultContext();
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

      if ((await readLedger()).initialized) {
        logSkip(
          "initialize",
          "vault is already initialized (rerun against a kept contract address)",
        );
      } else {
        await initialize(await deployerSession.vaultContext(), {
          vaultEvmAddress: requireEnv("EVM_VAULT_ACCOUNT_ADDRESS"),
          mpcResponseKey: requireEnv("MPC_VAULT_RESPONSE_PUBLIC_KEY"),
        });
      }

      expect((await readLedger()).initialized).toBe(1n);
    },
    15 * MINUTE,
  );
});
