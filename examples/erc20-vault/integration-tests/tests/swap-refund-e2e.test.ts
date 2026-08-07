// Swap REFUND round trip: deposit tokenIn, then submit a swap whose amountInMaximum is set
// below the real cost so exactOutputSingle reverts on-chain ("Too much requested"). The MPC
// attests the failure output and completeSwap routes to refund, re-minting the surrendered
// amountInMaximum of tokenIn. The swap-side twin of deposit-withdrawal-failure-refund. Uniswap
// only exists on Sepolia (or a Sepolia fork), so this suite gates on the router and self-skips.
import { requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { uniswapAvailable } from "../src/evm-swap.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { initialize } from "../src/flows/initialize.ts";
import { runSwapRoundTrip } from "../src/flows/swap.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

const EURC = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";
const FEE = 500n;
// exactOutput refund: request 3 EURC (~3.25 USDC to buy) but cap the spend at only 1 USDC. The
// deposited coin IS the surrendered cap, so deposit 1 USDC. On-chain the real cost exceeds the
// cap, so exactOutputSingle reverts ("Too much requested") and the swap must refund.
const AMOUNT_IN_MAX = 1_000_000n; // 1 USDC deposited + surrendered cap
const AMOUNT_OUT = 3_000_000n; // 3 EURC (costs far more than the 1 USDC cap)

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
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
        await initialize(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnvOf(env, "MPC_RESPONSE_KEY"),
        });
      }

      // Deposit funds the vault with tokenIn + gives the caller a shielded tokenIn coin of
      // exactly AMOUNT_IN_MAX (the coin the swap surrenders).
      await runDepositRoundTrip(session, { amount: AMOUNT_IN_MAX });

      // The caller's own shielded tokenIn balance (the owner can read it, though it is not
      // publicly observable): the swap burns the surrendered coin, and a successful refund
      // must re-mint it, leaving this balance unchanged (net-zero).
      const color = vaultTokenType(context.erc20Address, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(AMOUNT_IN_MAX);

      // amountInMaximum below the real cost -> exactOutputSingle reverts -> the settle re-mints tokenIn.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum: AMOUNT_IN_MAX,
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
