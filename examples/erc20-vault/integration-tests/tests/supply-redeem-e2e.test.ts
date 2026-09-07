// Aave lending round trip against the live stack, which runs on the Sepolia fork the setup
// pipeline verifies: the stataUSDC wrapper is deployed there, and the derived accounts hold
// ETH + real USDC. Here we deposit USDC to fund the vault + mint the caller a shielded USDC coin,
// supply it into the wrapper for shielded stataUSDC shares, then redeem the shares for shielded
// USDC (principal + accrued interest).
import { AAVE_USDC, STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

// 1 USDC (6 decimals). The wrapper's exchange rate is live, so the shares minted and the assets
// redeemed are read from the settle result, not hardcoded.
const SUPPLY_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault aave lending e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "deposits USDC, supplies it for shielded stataUSDC, then redeems the shares for shielded USDC",
    async () => {
      const context = await session.vaultContext();

      // The setup pipeline deploys the vault but does not initialise it (the key it pins
      // derives from the vault address), so seal the config here before any flow. A kept
      // contract address that is already initialised is left untouched.
      await initialise(context, resolveInitialiseConfig(env, context.vaultContractAddress));

      // Fund the vault + mint the caller a shielded USDC coin equal to the amount we supply.
      // Deposit Aave's USDC specifically (the wrapper's underlying), independent of the suite's
      // default ERC20_ADDRESS: the vault mints a distinct colour per token.
      await runDepositRoundTrip(session, { amount: SUPPLY_AMOUNT, erc20Address: AAVE_USDC });

      // The caller's own shielded balances (owner-readable): supply mints stataUSDC shares, redeem
      // mints USDC assets. Each must rise by exactly the settle result.
      const stataColor = vaultTokenType(STATA_USDC, context.vaultContractAddress);
      const usdcColor = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async (color: string) =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

      // Supply: burn the shielded USDC, mint the attested stataUSDC shares.
      const stataBefore = await readBalance(stataColor);
      const supplyResult = await runSupplyRoundTrip(session, { amount: SUPPLY_AMOUNT });
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);
      const stataAfter = await readBalance(stataColor);
      expect(stataAfter - stataBefore).toBe(supplyResult.shares);

      // Redeem the freshly minted shares: burn the shielded stataUSDC, mint the attested USDC.
      const usdcBefore = await readBalance(usdcColor);
      const redeemResult = await runRedeemRoundTrip(session, { shares: supplyResult.shares });
      expect(redeemResult.refunded).toBe(false);
      expect(redeemResult.assets).toBeGreaterThan(0n);
      const usdcAfter = await readBalance(usdcColor);
      expect(usdcAfter - usdcBefore).toBe(redeemResult.assets);

      console.log(
        `AAVE E2E OK: supplied ${String(SUPPLY_AMOUNT)} USDC -> ${String(supplyResult.shares)} ` +
          `stataUSDC, redeemed -> ${String(redeemResult.assets)} USDC`,
      );
    },
    30 * 60_000,
  );
});
