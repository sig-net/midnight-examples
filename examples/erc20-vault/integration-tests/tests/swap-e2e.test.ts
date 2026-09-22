// Swap round trip against the live stack, which runs on the Sepolia fork the setup pipeline
// verifies: the Uniswap router is deployed there, and the derived accounts hold ETH + real USDC.
// Here we deposit to fund the vault + mint the caller a shielded tokenIn coin, then swap it for
// tokenOut.
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// SWAP_E2E_DEPOSIT_REQUEST_ID / SWAP_E2E_SWAP_REQUEST_ID set to the ids the failed run
// printed. Each leg then resumes its request instead of recording a fresh one, and a leg a
// prior run already settled skips its settle.
import type { RequestIdHex } from "@sig-net/midnight";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { banner, getErc20Balance, getEthBalance } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { formatEther, formatUnits, parseEther } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { quoteExactOutputSingle } from "../src/evm-swap.ts";
import { SWAP_GAS_LIMIT, SWAP_MAX_FEE_PER_GAS } from "../src/evm-swap.ts";
import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import { runSwapRoundTrip } from "../src/flows/swap-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

const EURC = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";
const FEE = 500n;
// exactOutput: receive EXACTLY AMOUNT_OUT of EURC. The fork's USDC/EURC pool price is arbitrary
// (thin testnet liquidity, not ~1:1), so the input cap is sized from a LIVE quote rather than
// hardcoded. The deposited coin IS the surrendered coin, so we deposit exactly the quoted
// amountInMaximum; CAP_SLIPPAGE_BPS is generous headroom so the swap fits and leaves change.
const AMOUNT_OUT = 1_000_000n; // 1 EURC exact receive
const CAP_SLIPPAGE_BPS = 1000n; // 10% over the quote

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the quoted deposit, vault EVM account holds the approve + swap gas budget",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SWAP_E2E_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;

      // The user's derived account pays the sweep gas and supplies the deposited ERC20.
      const userEth = await getEthBalance(context.evmRpcUrl, context.evmUserAddress);
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
      );
      expect(
        userEth,
        `fund ${context.evmUserAddress} with >= 0.01 ETH on EVM`,
      ).toBeGreaterThanOrEqual(parseEther("0.01"));
      // The quoted cap the main test deposits (it re-quotes, and the pool does not move in between).
      const { amountInMaximum } = await quoteExactOutputSingle(
        context.evmRpcUrl,
        context.erc20Address,
        EURC,
        FEE,
        AMOUNT_OUT,
        CAP_SLIPPAGE_BPS,
      );
      // A resumed deposit already swept its ERC20, so nothing is required then.
      const required = depositResumeId === undefined ? amountInMaximum : 0n;
      const { balance, decimals } = await getErc20Balance(
        context.evmRpcUrl,
        context.erc20Address,
        context.evmUserAddress,
      );
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(balance, required, decimals, context.erc20Address)} (quoted deposit)`,
      );
      expect(
        balance,
        `fund ${context.evmUserAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${context.erc20Address} on EVM`,
      ).toBeGreaterThanOrEqual(required);

      // The vault's derived account sends the router approve (first use) and the swap itself.
      const gasBudget =
        ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS +
        SWAP_GAS_LIMIT * SWAP_MAX_FEE_PER_GAS;
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
    "deposits tokenIn, then swaps it for tokenOut and mints the shielded amountOut",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SWAP_E2E_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
      const swapResumeId = env.SWAP_E2E_SWAP_REQUEST_ID as RequestIdHex | undefined;

      // The setup pipeline deploys the vault but does not initialise it (the key it pins
      // derives from the vault address), so seal the config here before any flow. A kept
      // contract address that is already initialised is left untouched.
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      // Size the deposit/cap from a LIVE exactOutput quote (the fork pool price is arbitrary),
      // with generous headroom so the on-chain swap fits and leaves change. The deposited coin IS
      // the coin the swap surrenders, so it must equal the amountInMaximum the swap burns.
      const { amountInMaximum } = await quoteExactOutputSingle(
        context.evmRpcUrl,
        context.erc20Address,
        EURC,
        FEE,
        AMOUNT_OUT,
        CAP_SLIPPAGE_BPS,
      );
      const deposit = await runDepositRoundTrip(session, {
        amount: amountInMaximum,
        reuseRequestId: depositResumeId,
      });
      banner([
        `Deposit ${deposit.requestId} complete.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SWAP_E2E_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
      ]);

      // The caller's own shielded tokenOut balance before the swap: completeSwap mints exactly
      // the requested amountOut, so this must rise by AMOUNT_OUT (the owner can read it).
      const outColor = vaultTokenType(EURC, context.vaultContractAddress);
      const readOut = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[outColor] ??
        0n;
      const outBefore = await readOut();

      // Receive exactly AMOUNT_OUT, capping the spend at the quoted amountInMaximum (the coin we
      // deposited). The settle mints AMOUNT_OUT of tokenOut plus the unspent USDC change.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum,
        reuseRequestId: swapResumeId,
      });
      expect(result.refunded).toBe(false);
      // exactOutput: exactly AMOUNT_OUT is minted and some tokenIn was spent.
      expect(result.amountOut).toBe(AMOUNT_OUT);
      expect(result.amountIn).toBeGreaterThan(0n);
      // Less than the cap was spent (change exists). The cap is the one quoted above only when
      // this run recorded the swap: a resumed request carries the cap a prior run quoted.
      const underCap = swapResumeId === undefined ? result.amountIn < amountInMaximum : true;
      expect(underCap, "less than the cap was spent (change exists)").toBe(true);

      // The mint credited exactly AMOUNT_OUT to the caller's shielded tokenOut balance. A
      // request a prior run settled minted back then, so this run's balance stays put.
      const outAfter = await readOut();
      expect(outAfter - outBefore).toBe(result.settled ? AMOUNT_OUT : 0n);
      const change =
        swapResumeId === undefined
          ? `, ${String(amountInMaximum - result.amountIn)} USDC change`
          : "";
      console.log(
        `SWAP E2E OK: spent ${String(result.amountIn)} USDC -> ${String(AMOUNT_OUT)} EURC ` +
          `(+${String(AMOUNT_OUT)} tokenOut${change})`,
      );
    },
    5 * POLL_TIMEOUT_MS + 30 * 60_000,
  );
});
