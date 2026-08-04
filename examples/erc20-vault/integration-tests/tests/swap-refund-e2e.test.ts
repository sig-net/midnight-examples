// Swap REFUND round trip: deposit tokenIn, then submit a swap whose amountOutMin is set
// impossibly high so exactInputSingle reverts on-chain ("Too little received"). The MPC
// attests the failure output and completeSwap routes to refund, re-minting the surrendered
// tokenIn. The swap-side twin of deposit-withdrawal-failure-refund. Uniswap only exists on
// Sepolia (or a Sepolia fork), so this suite gates on the router and self-skips otherwise.
import { afterAll, describe, expect, it } from "vitest";

import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { createVaultSession } from "../src/vault-session.ts";
import { initialize } from "../src/flows/initialize.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { runSwapRoundTrip } from "../src/flows/swap.ts";
import { uniswapAvailable } from "../src/evm-swap.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

const EURC = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";
const FEE = 500n;
const AMOUNT = 5_000_000n; // 5 USDC in
// Far above any output 5 USDC could yield, so the router reverts and the swap must refund.
const IMPOSSIBLE_MIN_OUT = 1_000_000_000_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap-refund e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "refunds tokenIn when the swap reverts on-chain (amountOutMin unreachable)",
    async () => {
      const context = await session.vaultContext();
      if (!(await uniswapAvailable(context.evmRpcUrl))) {
        console.log("SKIP: Uniswap not deployed on this EVM chain (need Sepolia or a Sepolia fork)");
        return;
      }

      // Seal the config before any flow unless a kept contract address is already initialized.
      const readLedger = () => readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      if (!(await readLedger()).initialized) {
        await initialize(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: env.MPC_RESPONSE_KEY!,
        });
      }

      // Deposit funds the vault with tokenIn + gives the caller a shielded tokenIn coin.
      await runDepositRoundTrip(session, { amount: AMOUNT });

      // The caller's own shielded tokenIn balance (the owner can read it, though it is not
      // publicly observable): the swap burns the surrendered coin, and a successful refund
      // must re-mint it, leaving this balance unchanged (net-zero).
      const color = vaultTokenType(context.erc20Address, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(AMOUNT);

      // amountOutMin impossibly high -> exactInputSingle reverts -> the settle re-mints tokenIn.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountIn: AMOUNT,
        amountOutMin: IMPOSSIBLE_MIN_OUT,
      });
      expect(result).toBeDefined();
      expect(result!.refunded).toBe(true);

      // The refund re-minted exactly the surrendered tokenIn: the shielded balance is whole.
      const balanceAfter = await readBalance();
      expect(balanceAfter).toBe(balanceBefore);
      console.log(`SWAP REFUND E2E OK: swap reverted -> tokenIn refunded (shielded balance ${balanceBefore} restored)`);
    },
    30 * 60_000,
  );
});
