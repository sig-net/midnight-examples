// Aave supply REFUND round trip: deposit Aave USDC, drain the vault's Aave-USDC EVM balance, then
// supply. The wrapper's deposit does transferFrom(vault, ...) which reverts (the vault holds none),
// so the MPC attests failure and completeSupply routes to refund, re-minting the surrendered
// underlying. The lending twin of swap-refund-e2e / deposit-withdrawal-failure-refund. stataUSDC
// only exists on Sepolia (or a Sepolia fork), so this suite gates on the wrapper and self-skips.
import { requireEnv as requireEnvOf } from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { AAVE_USDC, stataAvailable } from "../src/evm-stata.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { initialize } from "../src/flows/initialize.ts";
import { runSupplyRoundTrip } from "../src/flows/supply.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
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
      if (!(await stataAvailable(context.evmRpcUrl))) {
        console.log(
          "SKIP: stataUSDC wrapper not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
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

      // Fund: deposit Aave USDC, minting the caller a shielded Aave-USDC coin and funding the
      // vault's EVM Aave-USDC balance (which the drain below then removes).
      await runDepositRoundTrip(session, { amount: SUPPLY_AMOUNT, erc20Address: AAVE_USDC });

      // The caller's own shielded Aave-USDC balance (owner-readable): the supply burns the
      // surrendered coin, and a successful refund re-mints it, leaving this net-zero.
      const color = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async () =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      const balanceBefore = await readBalance();
      expect(balanceBefore).toBeGreaterThanOrEqual(SUPPLY_AMOUNT);

      // Drain the vault's Aave-USDC EVM balance back to the user, so the wrapper's transferFrom
      // reverts. runSupplyRoundTrip fetches the vault nonce AFTER this, so the signed supply is the
      // account's next expected tx. The wrapper approval it also sets means the revert is purely
      // the zero balance, not a missing allowance.
      await drainVaultErc20(env, context.evmUserAddress, AAVE_USDC);

      // The supply's stataUSDC.deposit reverts on-chain -> the MPC attests failure -> the settle
      // re-mints the surrendered underlying (tolerateRevert is the round trip's default).
      const result = await runSupplyRoundTrip(session, { amount: SUPPLY_AMOUNT });
      if (!result)
        throw new Error("supply unexpectedly skipped (wrapper availability already checked)");
      expect(result.refunded).toBe(true);

      // The refund re-minted exactly the surrendered underlying: the shielded balance is whole.
      const balanceAfter = await readBalance();
      expect(balanceAfter).toBe(balanceBefore);
      console.log(
        `AAVE SUPPLY REFUND E2E OK: supply reverted -> underlying refunded ` +
          `(shielded balance ${String(balanceBefore)} restored)`,
      );
    },
    30 * 60_000,
  );
});
