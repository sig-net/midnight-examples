// Aave supply REFUND round trip: deposit Aave USDC, drain the vault's Aave-USDC EVM balance, then
// supply. The wrapper's deposit does transferFrom(vault, ...) which reverts (the vault holds none),
// so the MPC attests failure and completeSupply routes to refund, re-minting the surrendered
// underlying. The lending twin of swap-refund-e2e / deposit-withdrawal-failure-refund. It runs
// against the Sepolia fork the setup pipeline verifies, where the stataUSDC wrapper is deployed.
import { AAVE_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

// The deployer's session, for initialise only: the circuit is gated to the
// deployer identity (the deployer wallet seed's bytes, whose commitment the
// deploy sealed), so the user session cannot drive it. Lazily built like
// every session — a rerun against an initialised vault never starts it.
const deployerSession = createVaultSession({
  ...env,
  MIDNIGHT_USER1_WALLET_SEED: env.MIDNIGHT_DEPLOYER_WALLET_SEED ?? "",
});

// 1 USDC (6 decimals): deposited, surrendered by the doomed supply, and refunded whole.
const SUPPLY_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault aave supply-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
    await deployerSession.stop();
  });

  it(
    "refunds the underlying when the supply reverts on-chain (vault holds no USDC)",
    async () => {
      const context = await session.vaultContext();

      // The setup pipeline deploys the vault but does not initialise it (the key it pins
      // derives from the vault address), so seal the config here before any flow. A kept
      // contract address that is already initialised is left untouched.
      await initialise(
        await deployerSession.vaultContext(),
        resolveInitialiseConfig(env, context.vaultContractAddress),
      );

      // Fund: deposit Aave USDC, minting the caller a shielded Aave-USDC coin and funding the
      // vault's EVM Aave-USDC balance (which the drain below then removes).
      await runDepositRoundTrip(session, { amount: SUPPLY_AMOUNT, erc20Address: AAVE_USDC });

      // The caller's own shielded Aave-USDC balance (owner-readable): the supply burns the
      // surrendered coin, and a successful refund re-mints it, leaving this net-zero.
      const color = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(SUPPLY_AMOUNT);

      // Drain the vault's Aave-USDC EVM balance back to the user, so the wrapper's transferFrom
      // reverts. runSupplyRoundTrip fetches the vault nonce AFTER this, so the signed supply is the
      // account's next expected tx. The wrapper approval it also sets means the revert is purely
      // the zero balance, not a missing allowance.
      await drainVaultErc20(env, context.evmUserAddress, AAVE_USDC);

      // The supply's stataUSDC.deposit reverts on-chain -> the MPC attests failure -> the settle
      // re-mints the surrendered underlying (tolerateRevert is the round trip's default).
      const result = await runSupplyRoundTrip(session, { amount: SUPPLY_AMOUNT });
      expect(result.refunded).toBe(true);

      // The refund re-minted exactly the surrendered underlying: the shielded balance is whole.
      const balanceAfter = await readBalance();
      expect(balanceAfter).toBe(balanceBefore);
      console.log(
        `AAVE SUPPLY REFUND E2E OK: supply reverted -> underlying refunded ` +
          `(shielded balance ${String(balanceBefore)} restored)`,
      );
    },
    30 * 60_000,
  );
});
