import {
  OutputKind,
  requestIdBytes,
  type RequestIdHex,
  tronAddressFromEvm,
} from "@sig-net/midnight";
import {
  evmAddressBytes,
  pureCircuits,
  readVaultLedger,
  VAULT_TRON_APPROVE_REQUESTS_PATH,
  VAULT_TRON_SWAP_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  resolveAllowedTronTokens,
  resolveSunswapRouter,
  resolveTokenFeesFor,
  resolveTronUsdtAddress,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { addAllowedTronTokens } from "../src/flows/add-allowed-tron-tokens.ts";
import { broadcastTron } from "../src/flows/broadcast-tron.ts";
import { settleTronApprove } from "../src/flows/complete-tron-approve.ts";
import { settleTronSwap } from "../src/flows/complete-tron-swap.ts";
import { pollTronExecution } from "../src/flows/poll-tron-respond-bidirectional.ts";
import {
  pollTronSignedTransaction,
  type SignedTronTransaction,
} from "../src/flows/poll-tron-signature-response.ts";
import { refundUnsentTronSwap } from "../src/flows/refund-unsent-tron-swap.ts";
import type { RespondOutcome } from "../src/flows/respond-output.ts";
import { startTronApproveRouter } from "../src/flows/start-tron-approve.ts";
import { queueTronSwap, startTronSwap } from "../src/flows/start-tron-swap.ts";
import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import { flushUntil } from "../src/flows/vault-queue.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { withTronBlockPusher } from "../src/tron-block-pusher.ts";
import { createTronContext, type TronContext } from "../src/tron-context.ts";
import { getTrc20Allowance, getTrc20Balance, getTrxBalance } from "../src/tron-http.ts";
import { TRON_SWAP_POOL_FEE } from "../src/tron-sunswap.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env, "user");

const SWAP_AMOUNT_OUT = 1_000_000n;
const SWAP_AMOUNT_IN_MAXIMUM = 1_100_000n;
const BUY_USDT_AMOUNT_OUT = 400_000n;
const BUY_USDT_AMOUNT_IN_MAXIMUM = 500_000n;
const REFUND_AMOUNT_OUT = 40_000n;
const REFUND_AMOUNT_IN_MAXIMUM = 50_000n;
const REFUND_WINDOW_MS = 12n * 60_000n;

let tronContext: TronContext | undefined;
const tron = async (): Promise<TronContext> => (tronContext ??= await createTronContext(env));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron swap e2e: the vault's Tron account approves the SunSwap router and swaps",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    const tokenIn = (): Uint8Array => evmAddressBytes(resolveTronUsdtAddress(env));
    const tokenOut = async (): Promise<Uint8Array> => (await tron()).trc20Address;
    const router = (): Uint8Array => evmAddressBytes(resolveSunswapRouter(env));

    const vaultBalances = async (): Promise<{ sold: bigint; bought: bigint }> => {
      const t = await tron();
      return {
        sold: await getTrc20Balance(
          t.tronRpcUrl,
          tronAddressFromEvm(tokenIn()),
          t.tronVaultAddress.bytes,
        ),
        bought: await getTrc20Balance(
          t.tronRpcUrl,
          tronAddressFromEvm(t.trc20Address),
          t.tronVaultAddress.bytes,
        ),
      };
    };

    const sign = async (
      requestId: RequestIdHex,
      requestsPath: readonly number[],
    ): Promise<SignedTronTransaction> => {
      const context = await session.vaultContext();
      const { tronRpcUrl, funder, mpcRootPublicKey } = await tron();
      return withTronBlockPusher(tronRpcUrl, funder, () =>
        pollTronSignedTransaction(context, {
          requestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          mpcRootPublicKey,
          requestsPath,
        }),
      );
    };

    const attest = async (
      requestId: RequestIdHex,
      requestsPath: readonly number[],
    ): Promise<RespondOutcome> => {
      const context = await session.vaultContext();
      const t = await tron();
      return withTronBlockPusher(t.tronRpcUrl, t.funder, () =>
        pollTronExecution(context, t, {
          requestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath,
        }),
      );
    };

    it(
      "preflight: the vault sealed the SunSwap router, allows both TRC-20s, and its Tron account holds the swap fee limit",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.initialised, "run tests/happy-day-e2e.test.ts first").toBe(true);
        expect(state.sunswapRouter, "initialise seals TRON_SUNSWAP_ROUTER").toEqual(router());
        expect(state.sunswapRouter.some((byte) => byte !== 0)).toBe(true);

        await addAllowedTronTokens(
          context,
          resolveTokenFeesFor(env, resolveAllowedTronTokens(env)),
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.allowedTronTokens.member(tokenIn())).toBe(true);
        expect(after.allowedTronTokens.member(await tokenOut())).toBe(true);

        const { tronRpcUrl, tronVaultAddress } = await tron();
        const trx = await getTrxBalance(tronRpcUrl, tronVaultAddress.bytes);
        expect(trx, `fund ${tronVaultAddress.base58} with TRX`).toBeGreaterThanOrEqual(
          after.vaultTronFeeLimits.swap + after.vaultTronFeeLimits.approve,
        );
      },
      15 * MINUTE,
    );

    it(
      "arrange: a Tron deposit round trip mints the shielded TRC-20 the swap will surrender",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const swapFee = state.allowedTronTokens.lookup(tokenIn()).fees.swap;
        const { requestId } = await runTronDepositRoundTrip(session, await tron(), {
          amount: SWAP_AMOUNT_IN_MAXIMUM + swapFee,
          tokenAddress: tokenIn(),
          reuseRequestId: env.TRON_SWAP_E2E_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });
        banner([
          `Arrange Tron deposit ${requestId} complete.`,
          `Resume with TRON_SWAP_E2E_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);
        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    let approveRequestId: RequestIdHex;

    it(
      "startTronApproveRouter + sendTronApprove record the approval under the vault's derivation path",
      async () => {
        const context = await session.vaultContext();
        const reuse = env.TRON_SWAP_E2E_APPROVE_REQUEST_ID as RequestIdHex | undefined;
        approveRequestId =
          reuse ??
          (await startTronApproveRouter(context, await tron(), { tokenAddress: tokenIn() }));
        banner([
          `Tron router approval ${approveRequestId} sent.`,
          `Resume with TRON_SWAP_E2E_APPROVE_REQUEST_ID=${approveRequestId}`,
        ]);
        expect(approveRequestId).toMatch(/^[0-9a-f]{64}$/);
      },
      15 * MINUTE,
    );

    it(
      "the approval is signed with the vault's Tron key, executes, and grants the router the unlimited allowance",
      async () => {
        const t = await tron();
        const signed = await sign(approveRequestId, VAULT_TRON_APPROVE_REQUESTS_PATH);
        const info = await withTronBlockPusher(t.tronRpcUrl, t.funder, () =>
          broadcastTron(t, { ...signed, timeoutMs: POLL_TIMEOUT_MS }),
        );
        expect(info.receiptResult).toBe("SUCCESS");
        expect(
          await getTrc20Allowance(
            t.tronRpcUrl,
            tronAddressFromEvm(tokenIn()),
            t.tronVaultAddress.bytes,
            tronAddressFromEvm(router()),
          ),
        ).toBe(pureCircuits.unlimitedAllowance());
      },
      2 * POLL_TIMEOUT_MS + MINUTE,
    );

    it(
      "the MPC attests the approval executed, and completeTronApprove closes the request",
      async () => {
        const context = await session.vaultContext();
        const requestIndex = requestIdBytes(approveRequestId);
        const outcome = await attest(approveRequestId, VAULT_TRON_APPROVE_REQUESTS_PATH);
        expect(outcome.event.outputKind).toBe(OutputKind.executed);
        expect(outcome.serializedOutput).toEqual(Uint8Array.of(1));

        const before = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        if (!before.bidirectionalTronApproveMap.member(requestIndex)) {
          logSkip("completeTronApprove", `request ${approveRequestId} already settled`);
          return;
        }
        await settleTronApprove(context, outcome);
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronApproveMap.member(requestIndex)).toBe(false);
      },
      POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    let swapRequestId: RequestIdHex;

    it(
      "startTronSwap + sendTronSwap burn the shielded cap for an exact buy",
      async () => {
        const context = await session.vaultContext();
        const reuse = env.TRON_SWAP_E2E_SWAP_REQUEST_ID as RequestIdHex | undefined;
        swapRequestId =
          reuse ??
          (await startTronSwap(context, await tron(), {
            tokenAddressIn: tokenIn(),
            tokenAddressOut: await tokenOut(),
            fee: TRON_SWAP_POOL_FEE,
            amountOut: SWAP_AMOUNT_OUT,
            amountInMaximum: SWAP_AMOUNT_IN_MAXIMUM,
          }));
        const record = await session
          .responseReader(VAULT_TRON_SWAP_REQUESTS_PATH)
          .getTronSignatureRequest(swapRequestId);
        expect(record.txParams.contractAddress).toEqual(tronAddressFromEvm(router()));
        banner([
          `Tron swap ${swapRequestId} sent.`,
          `Resume with TRON_SWAP_E2E_SWAP_REQUEST_ID=${swapRequestId}`,
        ]);
      },
      15 * MINUTE,
    );

    let amountInOnTron: bigint | undefined;

    it(
      "the swap is signed with the vault's Tron key and executes on the SunSwap router",
      async () => {
        const t = await tron();
        const signed = await sign(swapRequestId, VAULT_TRON_SWAP_REQUESTS_PATH);
        const before = await vaultBalances();
        const info = await withTronBlockPusher(t.tronRpcUrl, t.funder, () =>
          broadcastTron(t, { ...signed, timeoutMs: POLL_TIMEOUT_MS }),
        );
        expect(info.receiptResult).toBe("SUCCESS");
        if (info.alreadyLanded) {
          logSkip("vault balance deltas", "the swap landed in a prior run");
          return;
        }
        const after = await vaultBalances();
        expect(after.bought - before.bought).toBe(SWAP_AMOUNT_OUT);
        amountInOnTron = before.sold - after.sold;
        expect(amountInOnTron).toBeGreaterThan(0n);
        expect(amountInOnTron).toBeLessThanOrEqual(SWAP_AMOUNT_IN_MAXIMUM);
      },
      2 * POLL_TIMEOUT_MS + MINUTE,
    );

    let swapOutcome: RespondOutcome;

    it(
      "the MPC attests the swap executed with the input it spent",
      async () => {
        swapOutcome = await attest(swapRequestId, VAULT_TRON_SWAP_REQUESTS_PATH);
        expect(swapOutcome.event.outputKind).toBe(OutputKind.executed);
        const amountIn = pureCircuits.swapAmountIn(swapOutcome.serializedOutput);
        expect(amountIn).toBeGreaterThan(0n);
        expect(amountIn).toBe(amountInOnTron ?? amountIn);
      },
      POLL_TIMEOUT_MS + MINUTE,
    );

    it(
      "completeTronSwap mints the exact amount bought and the unspent change, and consumes the request",
      async () => {
        const context = await session.vaultContext();
        const requestIndex = requestIdBytes(swapRequestId);
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        if (!ledger.bidirectionalTronSwapMap.member(requestIndex)) {
          logSkip("completeTronSwap", `swap ${swapRequestId} already settled`);
          return;
        }
        const soldColor = vaultTronTokenType(tokenIn(), context.vaultContractAddress);
        const boughtColor = vaultTronTokenType(await tokenOut(), context.vaultContractAddress);
        const wallet = await session.wallet();
        const before = (await wallet.facade.waitForSyncedState()).shielded.balances;
        const soldBefore = before[soldColor] ?? 0n;
        const boughtBefore = before[boughtColor] ?? 0n;

        const { request, amountIn } = await settleTronSwap(context, swapOutcome);
        if (amountIn === undefined) {
          throw new Error("completeTronSwap took its refund branch on an executed swap");
        }
        const change = request.amountInMaximum - amountIn;
        const minted = await waitForFacadeState(
          wallet.facade,
          (state) =>
            (state.shielded.balances[boughtColor] ?? 0n) >= boughtBefore + request.amountOut &&
            (state.shielded.balances[soldColor] ?? 0n) >= soldBefore + change,
        );
        expect(minted.shielded.balances[boughtColor] ?? 0n).toBe(boughtBefore + request.amountOut);
        expect(minted.shielded.balances[soldColor] ?? 0n).toBe(soldBefore + change);

        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronSwapMap.member(requestIndex)).toBe(false);
        expect(after.vaultTronTimestamps.isEmpty()).toBe(true);
        banner([
          `Tron swap ${swapRequestId} settled.`,
          `  bought: ${String(request.amountOut)}`,
          `  spent:  ${String(amountIn)} of the ${String(request.amountInMaximum)} cap`,
          `  change: ${String(change)} re-minted`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      "a swap that buys the USDT-like token executes: the vault approves the plain TRC-20, swaps it, and settles",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const usdtColor = vaultTronTokenType(tokenIn(), context.vaultContractAddress);
        const wallet = await session.wallet();
        const usdtBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[usdtColor] ?? 0n;

        const approveId = await startTronApproveRouter(context, t, {
          tokenAddress: await tokenOut(),
        });
        const approval = await withTronBlockPusher(t.tronRpcUrl, t.funder, async () =>
          broadcastTron(t, {
            ...(await sign(approveId, VAULT_TRON_APPROVE_REQUESTS_PATH)),
            timeoutMs: POLL_TIMEOUT_MS,
          }),
        );
        expect(approval.receiptResult).toBe("SUCCESS");
        await settleTronApprove(context, await attest(approveId, VAULT_TRON_APPROVE_REQUESTS_PATH));

        const swapId = await startTronSwap(context, t, {
          tokenAddressIn: await tokenOut(),
          tokenAddressOut: tokenIn(),
          fee: TRON_SWAP_POOL_FEE,
          amountOut: BUY_USDT_AMOUNT_OUT,
          amountInMaximum: BUY_USDT_AMOUNT_IN_MAXIMUM,
        });
        const vaultUsdtBefore = (await vaultBalances()).sold;
        const swap = await withTronBlockPusher(t.tronRpcUrl, t.funder, async () =>
          broadcastTron(t, {
            ...(await sign(swapId, VAULT_TRON_SWAP_REQUESTS_PATH)),
            timeoutMs: POLL_TIMEOUT_MS,
          }),
        );
        expect(swap.receiptResult).toBe("SUCCESS");
        expect((await vaultBalances()).sold - vaultUsdtBefore).toBe(BUY_USDT_AMOUNT_OUT);

        const outcome = await attest(swapId, VAULT_TRON_SWAP_REQUESTS_PATH);
        expect(outcome.event.outputKind).toBe(OutputKind.executed);
        const { amountIn } = await settleTronSwap(context, outcome);
        expect(amountIn).toBeGreaterThan(0n);
        const minted = await waitForFacadeState(
          wallet.facade,
          (state) => (state.shielded.balances[usdtColor] ?? 0n) >= usdtBefore + BUY_USDT_AMOUNT_OUT,
        );
        expect(minted.shielded.balances[usdtColor] ?? 0n).toBe(usdtBefore + BUY_USDT_AMOUNT_OUT);
      },
      4 * POLL_TIMEOUT_MS + 30 * MINUTE,
    );

    it(
      "refundUnsentTronSwap re-mints the cap of a flushed swap that was never sent, once it can no longer be sent",
      async () => {
        const context = await session.vaultContext();
        const wallet = await session.wallet();
        const soldColor = vaultTronTokenType(tokenIn(), context.vaultContractAddress);
        const soldBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[soldColor] ?? 0n;

        const { inIndex, outIndex } = await queueTronSwap(context, await tron(), {
          tokenAddressIn: tokenIn(),
          tokenAddressOut: await tokenOut(),
          fee: TRON_SWAP_POOL_FEE,
          amountOut: REFUND_AMOUNT_OUT,
          amountInMaximum: REFUND_AMOUNT_IN_MAXIMUM,
          windowMs: REFUND_WINDOW_MS,
        });
        const flushed = await flushUntil(
          context,
          (state) => !state.inputRequestBuffer.member(inIndex),
          { inIndexes: [inIndex], requestIds: [] },
        );
        const { fee } = flushed.tronSwapArgsMap.lookup(inIndex);
        expect(flushed.outputRequestBuffer.member(outIndex)).toBe(true);

        await refundUnsentTronSwap(context, inIndex);

        const refunded = await waitForFacadeState(
          wallet.facade,
          (state) => (state.shielded.balances[soldColor] ?? 0n) >= soldBefore - fee,
        );
        expect(refunded.shielded.balances[soldColor] ?? 0n).toBe(soldBefore - fee);
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.tronSwapArgsMap.member(inIndex)).toBe(false);
        expect(after.outputRequestBuffer.member(outIndex)).toBe(false);
        expect(after.vaultTronTimestamps.isEmpty()).toBe(true);
      },
      Number(REFUND_WINDOW_MS) + 15 * MINUTE,
    );
  },
);
