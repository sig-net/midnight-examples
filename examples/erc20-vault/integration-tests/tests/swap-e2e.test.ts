// Swap round trip against the live stack. Uniswap only exists on Sepolia (or a Sepolia fork:
// set SEPOLIA_FORK_RPC_URL on the compose anvil), so this suite gates on the router being
// deployed and self-skips otherwise (incl. CI's bare anvil). The setup pipeline deals the
// derived accounts ETH + real USDC on the fork; here we deposit to fund the vault + mint the
// caller a shielded tokenIn coin, then swap it for tokenOut.
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
        console.log("SKIP: Uniswap not deployed on this EVM chain (need Sepolia or a Sepolia fork)");
        return;
      }

      // The setup pipeline deploys the vault but does not initialize it (the key it pins
      // derives from the vault address), so seal the config here before any flow — unless a
      // kept contract address is already initialized.
      const readLedger = () => readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      if (!(await readLedger()).initialized) {
        await initialize(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: env.MPC_RESPONSE_KEY!,
        });
      }

      // Deposit funds the vault with tokenIn + gives the caller a shielded tokenIn coin.
      await runDepositRoundTrip(session, { amount: AMOUNT });

      // The caller's own shielded tokenOut balance before the swap: completeSwap mints exactly
      // the attested amountOut, so this must rise by amountOut (the owner can read it).
      const outColor = vaultTokenType(EURC, context.vaultContractAddress);
      const readOut = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[outColor] ?? 0n;
      const outBefore = await readOut();

      // Swap it for tokenOut; the settle mints the attested amountOut of shielded tokenOut.
      const result = await runSwapRoundTrip(session, { tokenOut: EURC, fee: FEE, amountIn: AMOUNT });
      expect(result).toBeDefined();
      expect(result!.refunded).toBe(false);
      expect(result!.amountOut).toBeGreaterThan(0n);

      // The mint credited exactly the attested amountOut to the caller's shielded balance.
      const outAfter = await readOut();
      expect(outAfter - outBefore).toBe(result!.amountOut);
      console.log(`SWAP E2E OK: ${AMOUNT} USDC -> ${result!.amountOut} EURC (shielded balance +${result!.amountOut})`);
    },
    30 * 60_000,
  );
});
