// Swap round trip against the live stack. Uniswap only exists on Sepolia (or a Sepolia fork:
// set SEPOLIA_FORK_RPC_URL on the compose anvil), so this suite gates on the router being
// deployed and self-skips otherwise (incl. CI's bare anvil). The setup pipeline deals the
// derived accounts ETH + real USDC on the fork; here we deposit to fund the vault + mint the
// caller a shielded tokenIn coin, then swap it for tokenOut.
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
// exactOutput: receive EXACTLY AMOUNT_OUT of EURC, spending up to AMOUNT_IN_MAX of USDC. The
// deposited coin IS the surrendered coin (the circuit burns amountInMaximum), so deposit the
// cap. The fork's USDC/EURC pool is thin and imbalanced (~4-5 USDC per EURC, not ~1:1), so keep
// the output small and the cap generous — 1 EURC costs a few USDC, well under 20, leaving change.
const AMOUNT_IN_MAX = 20_000_000n; // 20 USDC deposited + spend cap
const AMOUNT_OUT = 1_000_000n; // 1 EURC exact receive

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "deposits tokenIn, then swaps it for tokenOut and mints the shielded amountOut",
    async () => {
      const context = await session.vaultContext();
      if (!(await uniswapAvailable(context.evmRpcUrl))) {
        console.log(
          "SKIP: Uniswap not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
        );
        return;
      }

      // The setup pipeline deploys the vault but does not initialize it (the key it pins
      // derives from the vault address), so seal the config here before any flow — unless a
      // kept contract address is already initialized.
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

      // The caller's own shielded tokenOut balance before the swap: completeSwap mints exactly
      // the requested amountOut, so this must rise by AMOUNT_OUT (the owner can read it).
      const outColor = vaultTokenType(EURC, context.vaultContractAddress);
      const readOut = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[outColor] ??
        0n;
      const outBefore = await readOut();

      // Swap for tokenOut: cap the spend at the deposited coin (amountInMaximum override), receive
      // exactly AMOUNT_OUT. The settle mints AMOUNT_OUT of tokenOut plus the unspent USDC change.
      const result = await runSwapRoundTrip(session, {
        tokenOut: EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum: AMOUNT_IN_MAX,
      });
      if (!result)
        throw new Error("swap unexpectedly skipped (router availability already checked)");
      expect(result.refunded).toBe(false);
      // exactOutput: exactly AMOUNT_OUT is minted, and less than the cap was spent (change exists).
      expect(result.amountOut).toBe(AMOUNT_OUT);
      expect(result.amountIn).toBeGreaterThan(0n);
      expect(result.amountIn).toBeLessThan(AMOUNT_IN_MAX);

      // The mint credited exactly AMOUNT_OUT to the caller's shielded tokenOut balance.
      const outAfter = await readOut();
      expect(outAfter - outBefore).toBe(AMOUNT_OUT);
      const change = AMOUNT_IN_MAX - result.amountIn;
      console.log(
        `SWAP E2E OK: spent ${String(result.amountIn)} USDC -> ${String(AMOUNT_OUT)} EURC ` +
          `(+${String(AMOUNT_OUT)} tokenOut, ${String(change)} USDC change)`,
      );
    },
    30 * 60_000,
  );
});
