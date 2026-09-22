// Swap REFUND round trip: deposit tokenIn, then submit a swap whose amountInMaximum is set
// below the real cost so exactOutputSingle reverts on-chain ("Too much requested"). The MPC
// attests the failure output and completeSwap routes to refund, re-minting the surrendered
// amountInMaximum of tokenIn. The swap-side twin of deposit-withdrawal-failure-refund. It runs
// against the Sepolia fork the setup pipeline verifies, where the Uniswap router is deployed.
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// SWAP_REFUND_DEPOSIT_REQUEST_ID / SWAP_REFUND_SWAP_REQUEST_ID set to the ids the failed run
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
// exactOutput refund: request AMOUNT_OUT but cap the spend BELOW its real cost, so the router
// reverts ("Too much requested") and the swap must refund. The cost is arbitrary on the fork's
// thin pool, so derive the cap from a LIVE quote (half the quoted input) rather than hardcode.
const AMOUNT_OUT = 3_000_000n; // 3 EURC exact receive

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the deposited cap, vault EVM account holds the approve + swap gas budget",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SWAP_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;

      // The user's derived account pays the sweep gas and supplies the deposited ERC20.
      const userEth = await getEthBalance(context.evmRpcUrl, context.evmUserAddress);
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
      );
      expect(
        userEth,
        `fund ${context.evmUserAddress} with >= 0.01 ETH on EVM`,
      ).toBeGreaterThanOrEqual(parseEther("0.01"));
      // Half the live quote, the cap the main test deposits (it re-quotes, and the pool does not
      // move in between).
      const { amountIn: quotedIn } = await quoteExactOutputSingle(
        context.evmRpcUrl,
        context.erc20Address,
        EURC,
        FEE,
        AMOUNT_OUT,
      );
      // A resumed deposit already swept its ERC20, so nothing is required then.
      const required = depositResumeId === undefined ? quotedIn / 2n : 0n;
      const { balance, decimals } = await getErc20Balance(
        context.evmRpcUrl,
        context.erc20Address,
        context.evmUserAddress,
      );
      console.log(
        `${context.evmUserAddress}: ${fundingSummary(balance, required, decimals, context.erc20Address)} (deposited cap)`,
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
    "refunds tokenIn when the swap reverts on-chain (amountInMaximum too low)",
    async () => {
      const context = await session.vaultContext();
      const depositResumeId = env.SWAP_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
      const swapResumeId = env.SWAP_REFUND_SWAP_REQUEST_ID as RequestIdHex | undefined;

      // Seal the config before any flow. A kept contract address that is already initialised
      // is left untouched.
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      // Cap the spend at HALF the live quote — guaranteed under the real cost, so the swap
      // reverts. The deposited coin IS the surrendered cap, so deposit exactly it.
      const { amountIn: quotedIn } = await quoteExactOutputSingle(
        context.evmRpcUrl,
        context.erc20Address,
        EURC,
        FEE,
        AMOUNT_OUT,
      );
      const cap = quotedIn / 2n;
      const deposit = await runDepositRoundTrip(session, {
        amount: cap,
        reuseRequestId: depositResumeId,
      });
      banner([
        `Deposit ${deposit.requestId} complete.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SWAP_REFUND_DEPOSIT_REQUEST_ID=${deposit.requestId}`,
      ]);

      // The caller's own shielded tokenIn balance (the owner can read it, though it is not
      // publicly observable): the swap burns the surrendered coin, and a successful refund
      // must re-mint it, leaving this balance unchanged (net-zero).
      const color = vaultTokenType(context.erc20Address, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      // The coin the swap surrenders must be in hand before it is recorded, and a resumed request
      // already burned it, so nothing is required.
      expect(balanceBefore).toBeGreaterThanOrEqual(swapResumeId === undefined ? cap : 0n);

      // amountInMaximum (the cap) below the real cost -> exactOutputSingle reverts -> the settle re-mints tokenIn.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum: cap,
        reuseRequestId: swapResumeId,
      });
      expect(result.refunded).toBe(true);

      // The refund re-minted exactly the surrendered tokenIn. A fresh run burns and re-mints
      // within this run (net-zero). A resumed request burned its coin in the prior run, so the
      // run that settles observes only the re-mint, of the cap the prior run quoted (which this
      // run cannot read back, hence a strict rise rather than an exact delta).
      const balanceAfter = await readBalance();
      const delta = balanceAfter - balanceBefore;
      const refundObservedHere = swapResumeId !== undefined && result.settled;
      expect(
        refundObservedHere ? delta > 0n : delta === 0n,
        `shielded tokenIn balance moved by ${String(delta)}`,
      ).toBe(true);
      console.log(
        `SWAP REFUND E2E OK: swap reverted -> tokenIn refunded (shielded balance ${String(balanceAfter)})`,
      );
    },
    5 * POLL_TIMEOUT_MS + 30 * 60_000,
  );
});
