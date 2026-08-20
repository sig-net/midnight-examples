// Swap REFUND round trip: deposit tokenIn, then submit a swap whose amountInMaximum is set
// below the real cost so exactOutputSingle reverts on-chain ("Too much requested"). The MPC
// attests the failure output and completeSwap routes to refund, re-minting the surrendered
// amountInMaximum of tokenIn. The swap-side twin of deposit-withdrawal-failure-refund. Uniswap
// only exists on Sepolia (or a Sepolia fork), so this suite gates on the router and self-skips.
import { requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { quoteExactOutputSingle, uniswapAvailable } from "../src/evm-swap.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { initialize } from "../src/flows/initialize.ts";
import { runSwapRoundTrip } from "../src/flows/swap.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

// The deployer's session, for initialize only: the circuit is gated to the
// deployer identity (the deployer wallet seed's bytes, whose commitment the
// deploy sealed), so the user session cannot drive it. Lazily built like
// every session — a rerun against an initialized vault never starts it.
const deployerSession = createVaultSession({
  ...env,
  MIDNIGHT_USER1_WALLET_SEED: env.MIDNIGHT_DEPLOYER_WALLET_SEED ?? "",
});

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
    await deployerSession.stop();
  });

  it(
    "refunds tokenIn when the swap reverts on-chain (amountInMaximum too low)",
    async () => {
      const context = await session.vaultContext();
      if (!(await uniswapAvailable(context.evmRpcUrl))) {
        console.log(
          "SKIP: Uniswap not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
        );
        return;
      }

      // Seal the config before any flow unless a kept contract address is already initialized.
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      if (!(await readLedger()).initialized) {
        await initialize(await deployerSession.vaultContext(), {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnvOf(env, "MPC_VAULT_RESPONSE_PUBLIC_KEY"),
        });
      }

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
      await runDepositRoundTrip(session, { amount: cap });

      // The caller's own shielded tokenIn balance (the owner can read it, though it is not
      // publicly observable): the swap burns the surrendered coin, and a successful refund
      // must re-mint it, leaving this balance unchanged (net-zero).
      const color = vaultTokenType(context.erc20Address, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(cap);

      // amountInMaximum (the cap) below the real cost -> exactOutputSingle reverts -> the settle re-mints tokenIn.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum: cap,
      });
      if (!result)
        throw new Error("swap unexpectedly skipped (router availability already checked)");
      expect(result.refunded).toBe(true);

      // The refund re-minted exactly the surrendered tokenIn: the shielded balance is whole.
      const balanceAfter = await readBalance();
      expect(balanceAfter).toBe(balanceBefore);
      console.log(
        `SWAP REFUND E2E OK: swap reverted -> tokenIn refunded (shielded balance ${String(balanceBefore)} restored)`,
      );
    },
    30 * 60_000,
  );
});
