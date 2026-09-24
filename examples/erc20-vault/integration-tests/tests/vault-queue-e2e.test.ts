import { SIGNET_DEFAULT_KEY_VERSION } from "@sig-net/midnight";
import {
  AAVE_USDC,
  evmAddressBytes,
  pureCircuits,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { JsonRpcProvider, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { queueApproveRouter, sendApproveRouter } from "../src/flows/approve-router.ts";
import { queueApproveStata, sendApproveStata } from "../src/flows/approve-stata.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { initialise } from "../src/flows/initialise.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { proveAhead, submitProven } from "../src/flows/prove-ahead.ts";
import {
  flushPending,
  flushUntilNumbered,
  proveFlush,
  queueKey,
  unnumberedKeys,
} from "../src/flows/vault-queue.ts";
import type { VaultContext } from "../src/vault-context.ts";
import { createVaultSession } from "../src/vault-session.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);
const BEARER_SEED = env.BEARER_SEED ?? "";
const strangerSession = createVaultSession({
  ...env,
  USER_SEED: BEARER_SEED,
  VAULT_USER_SECRET_KEY: BEARER_SEED,
});
const MINUTE = 60_000;

const signedNonce = (transaction: Transaction, what: string): bigint => {
  if (transaction.nonce < 0) throw new Error(`${what} carries no nonce`);
  return BigInt(transaction.nonce);
};

const signatureOf = (context: VaultContext, requestId: string): Promise<Transaction> =>
  pollSignatureResponse(context, {
    requestId: requestId as never,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    expectedSigner: context.evmVaultAddress,
  });

const vaultChainNonce = async (context: VaultContext): Promise<bigint> =>
  BigInt(await new JsonRpcProvider(context.evmRpcUrl).getTransactionCount(context.evmVaultAddress));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault queue e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
    await strangerSession.stop();
  });

  it(
    "one flush numbers every queued request, and their sends mine in nonce order",
    async () => {
      const context = await session.vaultContext();
      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));
      const base = (
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
      ).vaultEvmNonce;
      const chainBefore = await vaultChainNonce(context);

      const queued = [
        {
          key: await queueApproveRouter(context),
          send: (key: Uint8Array) => sendApproveRouter(context, key),
        },
        {
          key: await queueApproveStata(context),
          send: (key: Uint8Array) => sendApproveStata(context, key),
        },
        {
          key: await queueApproveRouter(context, AAVE_USDC),
          send: (key: Uint8Array) => sendApproveRouter(context, key, AAVE_USDC),
        },
      ];
      const numbered = [];
      for (const entry of queued) {
        numbered.push({ ...entry, nonce: await flushUntilNumbered(context, entry.key) });
      }
      expect(new Set(numbered.map((entry) => entry.nonce))).toEqual(
        new Set([base, base + 1n, base + 2n]),
      );

      numbered.sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
      for (const entry of numbered) {
        const signed = await signatureOf(context, await entry.send(entry.key));
        expect(signedNonce(signed, `nonce ${String(entry.nonce)}`)).toBe(entry.nonce);
        expect((await broadcastEvm(context, { transaction: signed })).status).toBe(1);
      }
      expect(await vaultChainNonce(context)).toBe(chainBefore + 3n);
    },
    15 * MINUTE,
  );

  it(
    "a stranger can flush and send a request the owner queued",
    async () => {
      const context = await session.vaultContext();
      const stranger = await strangerSession.vaultContext();
      const key = await queueApproveRouter(context);
      await flushUntilNumbered(stranger, key);
      const signed = await signatureOf(context, await sendApproveRouter(stranger, key));
      expect((await broadcastEvm(context, { transaction: signed })).status).toBe(1);
    },
    10 * MINUTE,
  );

  it(
    "a higher nonce signed before a lower one is sent still mines after it",
    async () => {
      const context = await session.vaultContext();
      const chainBefore = await vaultChainNonce(context);
      const router = await queueApproveRouter(context);
      const stata = await queueApproveStata(context);
      const routerNonce = await flushUntilNumbered(context, router);
      const stataNonce = await flushUntilNumbered(context, stata);
      const routerIsHigher = routerNonce > stataNonce;
      const higher = routerIsHigher
        ? { nonce: routerNonce, send: () => sendApproveRouter(context, router) }
        : { nonce: stataNonce, send: () => sendApproveStata(context, stata) };
      const lower = routerIsHigher
        ? { nonce: stataNonce, send: () => sendApproveStata(context, stata) }
        : { nonce: routerNonce, send: () => sendApproveRouter(context, router) };

      const higherSigned = await signatureOf(context, await higher.send());
      expect(signedNonce(higherSigned, "higher")).toBe(higher.nonce);
      expect(await vaultChainNonce(context)).toBe(chainBefore);

      const lowerSigned = await signatureOf(context, await lower.send());
      expect(signedNonce(lowerSigned, "lower")).toBe(lower.nonce);
      expect((await broadcastEvm(context, { transaction: lowerSigned })).status).toBe(1);
      expect((await broadcastEvm(context, { transaction: higherSigned })).status).toBe(1);
      expect(await vaultChainNonce(context)).toBe(chainBefore + 2n);
    },
    15 * MINUTE,
  );

  it(
    "two flushes in the same block: exactly one wins, the loser's retry numbers nothing",
    async () => {
      const context = await session.vaultContext();
      const stranger = await strangerSession.vaultContext();
      const router = await queueApproveRouter(context);
      const stata = await queueApproveStata(context);
      const pending = (await unnumberedKeys(context)).length;
      const before = (
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
      ).vaultEvmNonce;

      const outcomes = await Promise.allSettled([flushPending(context), flushPending(stranger)]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const after = (
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
      ).vaultEvmNonce;
      expect(after).toBe(before + BigInt(Math.min(pending, 20)));

      const loser = outcomes[0].status === "rejected" ? context : stranger;
      expect(await flushPending(loser)).toBe(0);

      const stamped = [
        {
          nonce: await flushUntilNumbered(context, router),
          send: () => sendApproveRouter(context, router),
        },
        {
          nonce: await flushUntilNumbered(context, stata),
          send: () => sendApproveStata(context, stata),
        },
      ].sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
      for (const { nonce, send } of stamped) {
        const signed = await signatureOf(context, await send());
        expect(signedNonce(signed, `nonce ${String(nonce)}`)).toBe(nonce);
        expect((await broadcastEvm(context, { transaction: signed })).status).toBe(1);
      }
    },
    15 * MINUTE,
  );

  it(
    "a flush proven before another request lands is refused unless it numbered every waiting request",
    async () => {
      const context = await session.vaultContext();
      const stranger = await strangerSession.vaultContext();
      const router = await queueApproveRouter(context);
      const waiting = await unnumberedKeys(context);
      expect(waiting).toContainEqual(router);

      const staleFlush = await proveFlush(context, waiting);
      const usdc = evmAddressBytes(AAVE_USDC);
      const lateApprove = await proveAhead(context, "approveRouter", [
        usdc,
        SIGNET_DEFAULT_KEY_VERSION,
      ]);
      const late = queueKey(context, pureCircuits.approveRouterBinder(usdc));
      const stata = await queueApproveStata(stranger);

      expect(await submitProven(context, lateApprove)).toBe("SucceedEntirely");
      const staleStatus = await submitProven(context, staleFlush);
      console.log(`stale flush: ${staleStatus}`);
      expect(staleStatus).not.toBe("SucceedEntirely");
      expect(await unnumberedKeys(context)).toHaveLength(waiting.length + 2);

      await flushUntilNumbered(stranger, stata);
      expect(await unnumberedKeys(context)).toHaveLength(0);
      expect(
        (await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress))
          .unflushed,
      ).toBe(0n);

      const stamped = [
        {
          nonce: await flushUntilNumbered(context, router),
          send: () => sendApproveRouter(context, router),
        },
        {
          nonce: await flushUntilNumbered(context, late),
          send: () => sendApproveRouter(context, late, AAVE_USDC),
        },
        {
          nonce: await flushUntilNumbered(context, stata),
          send: () => sendApproveStata(stranger, stata),
        },
      ].sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
      for (const { nonce, send } of stamped) {
        const signed = await signatureOf(context, await send());
        expect(signedNonce(signed, `nonce ${String(nonce)}`)).toBe(nonce);
        expect((await broadcastEvm(context, { transaction: signed })).status).toBe(1);
      }
    },
    15 * MINUTE,
  );
});
