// Aave redeem REFUND round trip: deposit Aave USDC, supply it for shielded stataUSDC shares,
// drain the vault's stataUSDC EVM balance, then redeem. The wrapper's redeem burns the vault's
// shares, which reverts (the vault holds none), so the MPC attests failure and the settle routes
// to refundRedeem, re-minting the surrendered shares. The redeem twin of supply-refund-e2e, and
// the one spec that proves the refundRedeem circuit. It runs against the Sepolia fork the setup
// pipeline verifies, where the stataUSDC wrapper is deployed.
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// REDEEM_REFUND_DEPOSIT_REQUEST_ID / REDEEM_REFUND_SUPPLY_REQUEST_ID /
// REDEEM_REFUND_REDEEM_REQUEST_ID set to the ids the failed run printed. Each leg then resumes
// its request instead of recording a fresh one, and a leg a prior run already settled skips
// its settle.
import type { RequestIdHex } from "@sig-net/midnight";
import { AAVE_USDC, STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
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
      const depositResumeId = env.REDEEM_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
      const supplyResumeId = env.REDEEM_REFUND_SUPPLY_REQUEST_ID as RequestIdHex | undefined;
      const redeemResumeId = env.REDEEM_REFUND_REDEEM_REQUEST_ID as RequestIdHex | undefined;

      // Seal the config before any flow. A kept contract address that is already initialised
      // is left untouched.
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      // Fund: deposit Aave USDC, then supply it so the caller holds shielded stataUSDC shares
      // and the vault's EVM account holds the wrapper tokens the drain below removes.
      const deposit = await runDepositRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        erc20Address: AAVE_USDC,
        reuseRequestId: depositResumeId,
      });
      banner([
        `Deposit ${deposit.requestId} complete.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  REDEEM_REFUND_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
      ]);
      const supplyResult = await runSupplyRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        reuseRequestId: supplyResumeId,
      });
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);
      banner([
        `Supply ${supplyResult.requestId} settled for ${String(supplyResult.shares)} shares.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  REDEEM_REFUND_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
        `  REDEEM_REFUND_SUPPLY_REQUEST_ID=${supplyResult.requestId}`,
      ]);

      // The caller's own shielded stataUSDC balance (owner-readable): the redeem burns the
      // surrendered shares, and a successful refund re-mints them, leaving this net-zero.
      const stataColor = vaultTokenType(STATA_USDC, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[
          stataColor
        ] ?? 0n;
      const balanceBefore = await readBalance();
      // The shares the redeem surrenders must be in hand before it is recorded; a resumed
      // request already burned them, so nothing is required.
      expect(balanceBefore).toBeGreaterThanOrEqual(
        redeemResumeId === undefined ? supplyResult.shares : 0n,
      );

      if (redeemResumeId === undefined) {
        // Drain the vault's stataUSDC EVM balance to the user, so the wrapper's redeem (burning
        // the vault's shares) reverts. runRedeemRoundTrip fetches the vault nonce AFTER this, so
        // the signed redeem is the account's next expected tx.
        await drainVaultErc20(env, context.evmUserAddress, STATA_USDC);
      } else {
        // A resumed request was recorded after its drain.
        logSkip("drain", "REDEEM_REFUND_REDEEM_REQUEST_ID present, resuming past the drain");
      }

      // The redeem's stataUSDC.redeem reverts on-chain -> the MPC attests failure -> the settle
      // re-mints the surrendered shares (tolerateRevert is the round trip's default).
      const result = await runRedeemRoundTrip(session, {
        shares: supplyResult.shares,
        reuseRequestId: redeemResumeId,
      });
      expect(result.refunded).toBe(true);
      expect(result.assets).toBe(0n);

      // The refund re-minted exactly the surrendered shares. A fresh run burns and re-mints
      // within this run (net-zero); a resumed request burned its shares in the prior run, so
      // this run observes only the re-mint, and only when it is the run that settles.
      const balanceAfter = await readBalance();
      const expectedDelta =
        redeemResumeId !== undefined && result.settled ? supplyResult.shares : 0n;
      expect(balanceAfter - balanceBefore).toBe(expectedDelta);
      console.log(
        `AAVE REDEEM REFUND E2E OK: redeem reverted -> shares refunded ` +
          `(shielded stataUSDC balance ${String(balanceAfter)})`,
      );
    },
    7 * POLL_TIMEOUT_MS + 30 * 60_000,
  );
});
