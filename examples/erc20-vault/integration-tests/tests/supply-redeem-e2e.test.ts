// Aave lending round trip against the live stack. The stataUSDC wrapper only exists on Sepolia
// (or a Sepolia fork), so this suite gates on the wrapper being deployed: it self-skips on a
// local un-forked anvil, but in CI (where the fork is mandatory) an unavailable wrapper FAILS,
// so a fork misconfiguration cannot turn the gate green while covering nothing.
// The setup pipeline deals the derived accounts ETH + real
// USDC on the fork; here we deposit USDC to fund the vault + mint the caller a shielded USDC
// coin, supply it into the wrapper for shielded stataUSDC shares, then redeem the shares for
// shielded USDC (principal + accrued interest).
import { requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { AAVE_USDC, STATA_USDC, stataAvailable } from "../src/evm-stata.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
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
      if (!(await stataAvailable(context.evmRpcUrl))) {
        if (env.CI) {
          throw new Error(
            "stataUSDC wrapper unavailable on the CI fork: the Aave gate must run in CI, not skip",
          );
        }
        console.log(
          "SKIP: stataUSDC wrapper not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
        );
        return;
      }
      // The setup pipeline deploys the vault but does not initialise it (the key it pins derives
      // from the vault address), so seal the config here before any flow — unless a kept contract
      // address is already initialised.
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      if (!(await readLedger()).initialised) {
        await initialise(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnvOf(env, "MPC_RESPONSE_KEY"),
        });
      }

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
      if (!supplyResult)
        throw new Error("supply unexpectedly skipped (wrapper availability already checked)");
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);
      const stataAfter = await readBalance(stataColor);
      expect(stataAfter - stataBefore).toBe(supplyResult.shares);

      // Redeem the freshly minted shares: burn the shielded stataUSDC, mint the attested USDC.
      const usdcBefore = await readBalance(usdcColor);
      const redeemResult = await runRedeemRoundTrip(session, { shares: supplyResult.shares });
      if (!redeemResult)
        throw new Error("redeem unexpectedly skipped (wrapper availability already checked)");
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
