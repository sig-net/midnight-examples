// Aave lending round trip against the live stack. The stataUSDC wrapper only exists on Sepolia
// (or a Sepolia fork), so this suite gates on the wrapper being deployed and self-skips
// otherwise (incl. CI's bare anvil). The setup pipeline deals the derived accounts ETH + real
// USDC on the fork; here we deposit USDC to fund the vault + mint the caller a shielded USDC
// coin, supply it into the wrapper for shielded stataUSDC shares, then redeem the shares for
// shielded USDC (principal + accrued interest).
import { AAVE_USDC, STATA_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitializeConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { stataAvailable } from "../src/evm-stata.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { initialize } from "../src/flows/initialize.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem.ts";
import { runSupplyRoundTrip } from "../src/flows/supply.ts";
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

// 1 USDC (6 decimals). The wrapper's exchange rate is live, so the shares minted and the assets
// redeemed are read from the settle result, not hardcoded.
const SUPPLY_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault aave lending e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
    await deployerSession.stop();
  });

  it(
    "deposits USDC, supplies it for shielded stataUSDC, then redeems the shares for shielded USDC",
    async () => {
      const context = await session.vaultContext();
      if (!(await stataAvailable(context.evmRpcUrl))) {
        console.log(
          "SKIP: stataUSDC wrapper not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
        );
        return;
      }
      // The setup pipeline deploys the vault but does not initialize it (the key it pins
      // derives from the vault address), so seal the config here before any flow. A kept
      // contract address that is already initialized is left untouched.
      await initialize(
        await deployerSession.vaultContext(),
        resolveInitializeConfig(env, context.vaultContractAddress),
      );

      // Fund the vault + mint the caller a shielded USDC coin equal to the amount we supply.
      // Deposit Aave's USDC specifically (the wrapper's underlying), independent of the suite's
      // default EVM_ERC20_CONTRACT_ADDRESS: the vault mints a distinct colour per token.
      await runDepositRoundTrip(session, { amount: SUPPLY_AMOUNT, erc20Address: AAVE_USDC });

      // The caller's own shielded balances (owner-readable): supply mints stataUSDC shares, redeem
      // mints USDC assets. Each must rise by exactly the settle result.
      const stataColor = vaultTokenType(STATA_USDC, context.vaultContractAddress);
      const usdcColor = vaultTokenType(AAVE_USDC, context.vaultContractAddress);
      const readBalance = async (color: string) =>
        (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

      // Supply: burn the shielded USDC, mint the attested stataUSDC shares.
      const stataBefore = await readBalance(stataColor);
      const supplyResult = await runSupplyRoundTrip(session, { amount: SUPPLY_AMOUNT });
      if (!supplyResult)
        throw new Error("supply unexpectedly skipped (wrapper availability already checked)");
      expect(supplyResult.refunded).toBe(false);
      expect(supplyResult.shares).toBeGreaterThan(0n);
      const stataAfter = await readBalance(stataColor);
      expect(stataAfter - stataBefore).toBe(supplyResult.shares);

      // Redeem the freshly minted shares: burn the shielded stataUSDC, mint the attested USDC.
      const usdcBefore = await readBalance(usdcColor);
      const redeemResult = await runRedeemRoundTrip(session, { shares: supplyResult.shares });
      if (!redeemResult)
        throw new Error("redeem unexpectedly skipped (wrapper availability already checked)");
      expect(redeemResult.refunded).toBe(false);
      expect(redeemResult.assets).toBeGreaterThan(0n);
      const usdcAfter = await readBalance(usdcColor);
      expect(usdcAfter - usdcBefore).toBe(redeemResult.assets);

      console.log(
        `AAVE E2E OK: supplied ${String(SUPPLY_AMOUNT)} USDC -> ${String(supplyResult.shares)} ` +
          `stataUSDC, redeemed -> ${String(redeemResult.assets)} USDC`,
      );
    },
    30 * 60_000,
  );
});
