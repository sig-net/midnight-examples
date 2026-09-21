// Aave lending round trip against the live stack, which runs on the Sepolia fork the setup
// pipeline verifies: the stataUSDC wrapper is deployed there, and the derived accounts hold
// ETH + real USDC. Here we deposit USDC to fund the vault + mint the caller a shielded USDC coin,
// supply it into the wrapper for shielded stataUSDC shares, then redeem the shares for shielded
// USDC (principal + accrued interest).
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// SUPPLY_REDEEM_DEPOSIT_REQUEST_ID / SUPPLY_REDEEM_SUPPLY_REQUEST_ID /
// SUPPLY_REDEEM_REDEEM_REQUEST_ID set to the ids the failed run printed. Each leg then resumes
// its request instead of recording a fresh one, and a leg a prior run already settled skips
// its settle.
import type { RequestIdHex } from "@sig-net/midnight";
import {
  AAVE_USDC,
  readVaultLedger,
  STATA_USDC,
  vaultGasEnvelope,
  type VaultGasKind,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { banner, getErc20Balance, getEthBalance } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { formatEther, formatUnits, parseEther } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
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
    "funding preflight: user EVM account holds the supplied USDC, vault EVM account holds the approve + supply + redeem gas budget",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SUPPLY_REDEEM_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;

      // The user's derived account pays the sweep gas and supplies the deposited ERC20.
      const userEth = await getEthBalance(context.evmRpcUrl, context.evmUserAddress);
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
      );
      expect(
        userEth,
        `fund ${context.evmUserAddress} with >= 0.01 ETH on EVM`,
      ).toBeGreaterThanOrEqual(parseEther("0.01"));
      // A resumed deposit already swept its ERC20, so nothing is required then.
      const required = depositResumeId === undefined ? SUPPLY_AMOUNT : 0n;
      const { balance, decimals } = await getErc20Balance(
        context.evmRpcUrl,
        AAVE_USDC,
        context.evmUserAddress,
      );
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(balance, required, decimals, AAVE_USDC)} (supplied amount)`,
      );
      expect(
        balance,
        `fund ${context.evmUserAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${AAVE_USDC} on EVM`,
      ).toBeGreaterThanOrEqual(required);

      // The vault's derived account sends the wrapper approve (first use), the supply and the redeem.
      const ledgerState = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      const cost = (kind: VaultGasKind): bigint => {
        const envelope = vaultGasEnvelope(ledgerState, kind);
        return envelope.gasLimit * envelope.maxFeePerGas;
      };
      const gasBudget = cost("approve") + cost("supply") + cost("redeem");
      const vaultEth = await getEthBalance(context.evmRpcUrl, context.evmVaultAddress);
      console.log(
        `${context.evmVaultAddress}: ${fundingSummary(vaultEth, gasBudget, 18, "ETH")} (maximum gas fee)`,
      );
      expect(
        vaultEth,
        `fund the vault's derived account ${context.evmVaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
      ).toBeGreaterThanOrEqual(gasBudget);
    },
    5 * 60_000,
  );

  it(
    "deposits USDC, supplies it for shielded stataUSDC, then redeems the shares for shielded USDC",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SUPPLY_REDEEM_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
      const supplyResumeId = env.SUPPLY_REDEEM_SUPPLY_REQUEST_ID as RequestIdHex | undefined;
      const redeemResumeId = env.SUPPLY_REDEEM_REDEEM_REQUEST_ID as RequestIdHex | undefined;

      // The setup pipeline deploys the vault but does not initialise it (the key it pins
      // derives from the vault address), so seal the config here before any flow. A kept
      // contract address that is already initialised is left untouched.
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      // Fund the vault + mint the caller a shielded USDC coin equal to the amount we supply.
      // Deposit Aave's USDC specifically (the wrapper's underlying), independent of the suite's
      // default ERC20_ADDRESS: the vault mints a distinct colour per token.
      const deposit = await runDepositRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        erc20Address: AAVE_USDC,
        reuseRequestId: depositResumeId,
      });
      banner([
        `Deposit ${deposit.requestId} complete.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SUPPLY_REDEEM_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
      ]);

      // The caller's own shielded balances (owner-readable): supply mints stataUSDC shares, redeem
      // mints USDC assets. Each must rise by exactly the settle result. A request a prior run
      // settled minted back then, so this run's balance stays put.
      const stataColor = vaultTokenType(STATA_USDC, context.vaultContractAddress);
      const usdcColor = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async (color: string) =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

      // Supply: burn the shielded USDC, mint the attested stataUSDC shares.
      const stataBefore = await readBalance(stataColor);
      const supplyResult = await runSupplyRoundTrip(session, {
        amount: SUPPLY_AMOUNT,
        reuseRequestId: supplyResumeId,
      });
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);
      const stataAfter = await readBalance(stataColor);
      expect(stataAfter - stataBefore).toBe(supplyResult.settled ? supplyResult.shares : 0n);
      banner([
        `Supply ${supplyResult.requestId} settled for ${String(supplyResult.shares)} shares.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SUPPLY_REDEEM_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
        `  SUPPLY_REDEEM_SUPPLY_REQUEST_ID=${supplyResult.requestId}`,
      ]);

      // Redeem the freshly minted shares: burn the shielded stataUSDC, mint the attested USDC.
      const usdcBefore = await readBalance(usdcColor);
      const redeemResult = await runRedeemRoundTrip(session, {
        shares: supplyResult.shares,
        reuseRequestId: redeemResumeId,
      });
      expect(redeemResult.refunded).toBe(false);
      expect(redeemResult.assets).toBeGreaterThan(0n);
      const usdcAfter = await readBalance(usdcColor);
      expect(usdcAfter - usdcBefore).toBe(redeemResult.settled ? redeemResult.assets : 0n);

      console.log(
        `AAVE E2E OK: supplied ${String(SUPPLY_AMOUNT)} USDC -> ${String(supplyResult.shares)} ` +
          `stataUSDC, redeemed -> ${String(redeemResult.assets)} USDC`,
      );
    },
    7 * POLL_TIMEOUT_MS + 30 * 60_000,
  );
});
