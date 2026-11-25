import { requestIdBytes, tronAddressFromEvm } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_WITHDRAW_REQUESTS_PATH,
  vaultTronTokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import {
  refundUnsentTronWithdraw,
  tronWithdrawRefundOpensAtMs,
} from "../src/flows/refund-unsent-tron-withdraw.ts";
import { queueTronWithdraw, sendTronWithdraw } from "../src/flows/start-tron-withdraw.ts";
import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import { runTronWithdrawRoundTrip } from "../src/flows/tron-withdraw-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createTronContext, type TronContext } from "../src/tron-context.ts";
import { getTrc20Balance, getTrxBalance } from "../src/tron-http.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env, "user");

const WITHDRAW_AMOUNT = 400_000n;
// Two minutes above the start's tronWithdrawStartMinRemainingSeconds(), which the block
// including the start must still clear after proving: the refund spec waits out most of it.
const REFUND_WINDOW_MS = 12n * 60_000n;

let tronContext: TronContext | undefined;
const tron = async (): Promise<TronContext> => (tronContext ??= await createTronContext(env));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron withdraw happy day e2e",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "preflight: the vault allows the test TRC-20 and its Tron account can pay the fee limit",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.allowedTronTokens.member(t.trc20Address), "run tron-deposit-e2e first").toBe(
          true,
        );
        const trx = await getTrxBalance(t.tronRpcUrl, t.tronVaultAddress.bytes);
        expect(trx, `fund ${t.tronVaultAddress.base58} with TRX`).toBeGreaterThanOrEqual(
          state.vaultTronFeeLimit,
        );
      },
      MINUTE,
    );

    it(
      "a Tron deposit gives the user the vault coins the two withdrawals surrender",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const needed = 2n * (WITHDRAW_AMOUNT + vaultTronTokenFees(state, t.trc20Address).withdraw);
        const wallet = await session.wallet();
        const color = vaultTronTokenType(t.trc20Address, context.vaultContractAddress);
        const held = (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        if (held < needed) {
          await runTronDepositRoundTrip(session, t, { amount: needed - held });
        }
        const synced = await waitForFacadeState(
          wallet.facade,
          (state) => (state.shielded.balances[color] ?? 0n) >= needed,
        );
        expect(synced.shielded.balances[color] ?? 0n).toBeGreaterThanOrEqual(needed);
      },
      POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "startTronWithdraw ... completeTronWithdraw pays the recipient on Tron and keeps the burn",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const token = tronAddressFromEvm(t.trc20Address);
        const recipient = tronAddressFromEvm(crypto.getRandomValues(new Uint8Array(20)));
        const wallet = await session.wallet();
        const color = vaultTronTokenType(t.trc20Address, context.vaultContractAddress);
        const coinsBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        const vaultBefore = await getTrc20Balance(t.tronRpcUrl, token, t.tronVaultAddress.bytes);

        const { requestId, outcome, settled } = await runTronWithdrawRoundTrip(session, t, {
          amount: WITHDRAW_AMOUNT,
          destTronAddress: recipient,
        });

        expect(settled).toBe(true);
        expect(outcome.succeeded).toBe(true);
        expect(outcome.serializedOutput).toEqual(Uint8Array.of(1));
        const record = await session
          .responseReader(VAULT_TRON_WITHDRAW_REQUESTS_PATH)
          .getTronTriggerSmartContractSignatureRequest(requestId)
          .catch(() => undefined);
        expect(record, "completeTronWithdraw removes the record").toBeUndefined();
        expect(await getTrc20Balance(t.tronRpcUrl, token, recipient)).toBe(WITHDRAW_AMOUNT);
        expect(await getTrc20Balance(t.tronRpcUrl, token, t.tronVaultAddress.bytes)).toBe(
          vaultBefore - WITHDRAW_AMOUNT,
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronWithdrawMap.member(requestIdBytes(requestId))).toBe(false);
        expect(after.tronLastSeen).toBeGreaterThanOrEqual(outcome.event.blockHeight);
        const fee = vaultTronTokenFees(after, t.trc20Address).withdraw;
        await waitForFacadeState(
          wallet.facade,
          (synced) =>
            (synced.shielded.balances[color] ?? 0n) === coinsBefore - WITHDRAW_AMOUNT - fee,
        );
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "a withdrawal nobody sent before its window closed to sends is refunded, fee kept",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const wallet = await session.wallet();
        const color = vaultTronTokenType(t.trc20Address, context.vaultContractAddress);
        const coinsBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        const queued = await queueTronWithdraw(context, t, {
          amount: WITHDRAW_AMOUNT,
          destTronAddress: tronAddressFromEvm(crypto.getRandomValues(new Uint8Array(20))),
          windowMs: REFUND_WINDOW_MS,
        });
        const opensAt = tronWithdrawRefundOpensAtMs(queued.window.expiration);
        await new Promise((resolve) => setTimeout(resolve, Number(opensAt) - Date.now()));
        await expect(sendTronWithdraw(context, queued)).rejects.toThrow(/too close/);
        await refundUnsentTronWithdraw(context, { inIndex: queued.inIndex });

        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.outputRequestBuffer.member(queued.outIndex)).toBe(false);
        expect(after.bidirectionalTronWithdrawMap.member(requestIdBytes(queued.requestId))).toBe(
          false,
        );
        const fee = vaultTronTokenFees(after, t.trc20Address).withdraw;
        await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) === coinsBefore - fee,
        );
      },
      Number(REFUND_WINDOW_MS) + 15 * MINUTE,
    );
  },
);
