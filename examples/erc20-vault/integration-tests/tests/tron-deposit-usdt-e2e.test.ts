import type { RequestIdHex } from "@sig-net/midnight";
import { evmAddressBytes, readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  resolveAllowedTronTokens,
  resolveTokenFeesFor,
  resolveTronUsdtAddress,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { addAllowedTronTokens } from "../src/flows/add-allowed-tron-tokens.ts";
import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createTronContext } from "../src/tron-context.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env, "user");

const DEPOSIT_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron USDT deposit e2e: the token at tronUsdtAddress returns false and still mints",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    const usdt = (): Uint8Array => evmAddressBytes(resolveTronUsdtAddress(env));

    it(
      "preflight: the vault sealed TRON_USDT_ADDRESS as tronUsdtAddress, and the deployer allows it",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.initialised, "run tests/happy-day-e2e.test.ts first").toBe(true);
        expect(state.tronUsdtAddress, "initialise seals TRON_USDT_ADDRESS").toEqual(usdt());

        await addAllowedTronTokens(
          context,
          resolveTokenFeesFor(env, resolveAllowedTronTokens(env)),
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.allowedTronTokens.member(usdt())).toBe(true);
      },
      15 * MINUTE,
    );

    it(
      "a USDT-like transfer returns false, the MPC attests it, and completeTronDeposit mints",
      async () => {
        const context = await session.vaultContext();
        const wallet = await session.wallet();
        const color = vaultTronTokenType(usdt(), context.vaultContractAddress);
        const before = (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        const { requestId, claimed } = await runTronDepositRoundTrip(
          session,
          await createTronContext(env),
          {
            amount: DEPOSIT_AMOUNT,
            tokenAddress: usdt(),
            reuseRequestId: env.TRON_USDT_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
          },
        );
        banner([`Resume with TRON_USDT_DEPOSIT_REQUEST_ID=${requestId}`]);
        if (!claimed) {
          logSkip("USDT vault token delta", `request ${requestId} was claimed by a prior run`);
          return;
        }
        await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) >= before + DEPOSIT_AMOUNT,
        );
        const after = (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        expect(after - before).toBe(DEPOSIT_AMOUNT);
      },
      3 * POLL_TIMEOUT_MS + 20 * MINUTE,
    );
  },
);
