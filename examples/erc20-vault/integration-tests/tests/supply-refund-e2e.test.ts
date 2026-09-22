// Aave supply REFUND round trip: deposit Aave USDC, drain the vault's Aave-USDC EVM balance, then
// supply. The wrapper's deposit does transferFrom(vault, ...) which reverts (the vault holds none),
// so the MPC attests failure and completeSupply routes to refund, re-minting the surrendered
// underlying. The lending twin of swap-refund-e2e / deposit-withdrawal-failure-refund. It runs
// against the Sepolia fork the setup pipeline verifies, where the stataUSDC wrapper is deployed.
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// SUPPLY_REFUND_DEPOSIT_REQUEST_ID / SUPPLY_REFUND_SUPPLY_REQUEST_ID set to the ids the failed
// run printed. Each leg then resumes its request instead of recording a fresh one, and a leg a
// prior run already settled skips its settle.
import type { RequestIdHex } from "@sig-net/midnight";
import { AAVE_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

// 1 USDC (6 decimals): deposited, surrendered by the doomed supply, and refunded whole.
const SUPPLY_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault aave supply-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "refunds the underlying when the supply reverts on-chain (vault holds no USDC)",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SUPPLY_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
      const supplyResumeId = env.SUPPLY_REFUND_SUPPLY_REQUEST_ID as RequestIdHex | undefined;

      // Seal the config before any flow. A kept contract address that is already initialised
      // is left untouched.
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      // Fund: deposit Aave USDC, minting the caller a shielded Aave-USDC coin and funding the
      // vault's EVM Aave-USDC balance (which the drain below then removes).
      const deposit = await runDepositRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        erc20Address: AAVE_USDC,
        reuseRequestId: depositResumeId,
      });
      banner([
        `Deposit ${deposit.requestId} complete.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SUPPLY_REFUND_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
      ]);

      // The caller's own shielded Aave-USDC balance (owner-readable): the supply burns the
      // surrendered coin, and a successful refund re-mints it, leaving this net-zero.
      const color = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      // The coin the supply surrenders must be in hand before it is recorded; a resumed request
      // already burned it, so nothing is required.
      expect(balanceBefore).toBeGreaterThanOrEqual(
        supplyResumeId === undefined ? SUPPLY_AMOUNT : 0n,
      );

      if (supplyResumeId === undefined) {
        // Drain the vault's Aave-USDC EVM balance back to the user, so the wrapper's transferFrom
        // reverts. runSupplyRoundTrip fetches the vault nonce AFTER this, so the signed supply is
        // the account's next expected tx. The wrapper approval it also sets means the revert is
        // purely the zero balance, not a missing allowance.
        await drainVaultErc20(env, context.evmUserAddress, AAVE_USDC);
      } else {
        // A resumed request was recorded after its drain.
        logSkip("drain", "SUPPLY_REFUND_SUPPLY_REQUEST_ID present, resuming past the drain");
      }

      // The supply's stataUSDC.deposit reverts on-chain -> the MPC attests failure -> the settle
      // re-mints the surrendered underlying (tolerateRevert is the round trip's default).
      const result = await runSupplyRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        reuseRequestId: supplyResumeId,
      });
      expect(result.refunded).toBe(true);

      // The refund re-minted exactly the surrendered underlying. A fresh run burns and re-mints
      // within this run (net-zero); a resumed request burned its coin in the prior run, so this
      // run observes only the re-mint, and only when it is the run that settles.
      const balanceAfter = await readBalance();
      const expectedDelta = supplyResumeId !== undefined && result.settled ? SUPPLY_AMOUNT : 0n;
      expect(balanceAfter - balanceBefore).toBe(expectedDelta);
      console.log(
        `AAVE SUPPLY REFUND E2E OK: supply reverted -> underlying refunded ` +
          `(shielded balance ${String(balanceAfter)})`,
      );
    },
    5 * POLL_TIMEOUT_MS + 30 * 60_000,
  );
});
