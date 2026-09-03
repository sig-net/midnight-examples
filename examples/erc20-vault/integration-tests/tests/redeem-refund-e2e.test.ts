// Aave redeem REFUND round trip: deposit Aave USDC, supply it for shielded stataUSDC shares,
// drain the vault's stataUSDC EVM balance, then redeem. The wrapper's redeem burns the vault's
// shares, which reverts (the vault holds none), so the MPC attests failure and the settle routes
// to refundRedeem, re-minting the surrendered shares. The redeem twin of supply-refund-e2e, and
// the one spec that proves the refundRedeem circuit. It runs against the Sepolia fork the setup
// pipeline verifies, where the stataUSDC wrapper is deployed.
import { requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { AAVE_USDC, STATA_USDC } from "../src/evm-stata.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

// 1 USDC (6 decimals): deposited, supplied for shares, and the shares refunded whole.
const SUPPLY_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault aave redeem-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "refunds the shares when the redeem reverts on-chain (vault holds no stataUSDC)",
    async () => {
      const context = await session.vaultContext();

      // Seal the config before any flow unless a kept contract address is already initialised.
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      if (!(await readLedger()).initialised) {
        await initialise(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnvOf(env, "MPC_RESPONSE_KEY"),
        });
      }

      // Fund: deposit Aave USDC, then supply it so the caller holds shielded stataUSDC shares
      // and the vault's EVM account holds the wrapper tokens the drain below removes.
      await runDepositRoundTrip(session, { amount: SUPPLY_AMOUNT, erc20Address: AAVE_USDC });
      const supplyResult = await runSupplyRoundTrip(session, { amount: SUPPLY_AMOUNT });
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);

      // The caller's own shielded stataUSDC balance (owner-readable): the redeem burns the
      // surrendered shares, and a successful refund re-mints them, leaving this net-zero.
      const stataColor = vaultTokenType(STATA_USDC, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[
          stataColor
        ] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(supplyResult.shares);

      // Drain the vault's stataUSDC EVM balance to the user, so the wrapper's redeem (burning
      // the vault's shares) reverts. runRedeemRoundTrip fetches the vault nonce AFTER this, so
      // the signed redeem is the account's next expected tx.
      await drainVaultErc20(env, context.evmUserAddress, STATA_USDC);

      // The redeem's stataUSDC.redeem reverts on-chain -> the MPC attests failure -> the settle
      // re-mints the surrendered shares (tolerateRevert is the round trip's default).
      const result = await runRedeemRoundTrip(session, { shares: supplyResult.shares });
      expect(result.refunded).toBe(true);
      expect(result.assets).toBe(0n);

      // The refund re-minted exactly the surrendered shares: the shielded balance is whole.
      const balanceAfter = await readBalance();
      expect(balanceAfter).toBe(balanceBefore);
      console.log(
        `AAVE REDEEM REFUND E2E OK: redeem reverted -> shares refunded ` +
          `(shielded stataUSDC balance ${String(balanceBefore)} restored)`,
      );
    },
    30 * 60_000,
  );
});
