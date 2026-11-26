// The Tron lend e2e flow on the local Tron chain: the setup deploys an OpenZeppelin 5
// ERC-4626 with a decimals offset of 12 over the USDT-like TRC-20 (18-decimal shares over
// a 6-decimal asset, as JustLend V2's jUSDTv2 over Tron USDT), and this file lists the
// share token with factor 10^12, pairs it, approves it, supplies USDT-like coins for share
// coins, withdraws share coins to Tron, redeems the rest after yield, and refunds a supply
// nobody sent. Each leg runs start, flush, send, MPC signature, broadcast, MPC attestation
// and settle through the example's typed flows. The suite's user identity is the deployer
// (the setup defaults VAULT_DEPLOYER_SECRET_KEY to it), which the listing, the pair and the
// approval need. Run AFTER tests/tron-deposit-usdt-e2e.test.ts (FILE_ORDER).
import { bytesToBigint, OutputKind, requestIdBytes, tronAddressFromEvm } from "@sig-net/midnight";
import {
  evmAddressBytes,
  pureCircuits,
  readVaultLedger,
  vaultTronTokenConfig,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  resolveTronLendPair,
  resolveTronTokenListings,
  SetTronLendPairOutcome,
  tronTokenAddress,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import { requireEnv } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { addAllowedTronTokens } from "../src/flows/add-allowed-tron-tokens.ts";
import { refundUnsentTronSupply } from "../src/flows/refund-unsent-tron-lend.ts";
import { setTronLendPair } from "../src/flows/set-tron-lend-pair.ts";
import { queueTronSupply, sendTronSupply } from "../src/flows/start-tron-supply.ts";
import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import {
  runTronApproveRoundTrip,
  runTronRedeemRoundTrip,
  runTronSupplyRoundTrip,
} from "../src/flows/tron-lend-round-trip.ts";
import { tronAttestedUnits, tronRefundOpensAtMs } from "../src/flows/tron-vault-request.ts";
import { runTronWithdrawRoundTrip } from "../src/flows/tron-withdraw-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createTronContext, type TronContext } from "../src/tron-context.ts";
import {
  getTrc20Balance,
  getTrxBalance,
  sendTrc20,
  waitForTronTransaction,
} from "../src/tron-http.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env, "user");

// The share token's factor: 18-decimal shares over 6-decimal USDT-like coins.
const SHARE_FACTOR = 10n ** 12n;

// 30 USDT-like coins: the shares it returns, ~3 * 10^19, exceed 2^64.
const SUPPLY_AMOUNT = 30_000_000n;

// 1 USDT-like coin, donated to the share token as yield before the redeem.
const YIELD_DONATION = 1_000_000n;

// Share coin units the withdraw moves to Tron, which the transfer multiplies by 10^12.
const SHARE_WITHDRAW_UNITS = 1_000_000n;

// Two minutes above the start's tronStartMinRemainingSeconds(), which the block including
// the start must still clear after proving: the refund spec waits out most of it.
const REFUND_WINDOW_MS = 12n * 60_000n;

let tronContext: TronContext | undefined;
const tron = async (): Promise<TronContext> => (tronContext ??= await createTronContext(env));

const underlying = (): Uint8Array =>
  evmAddressBytes(tronTokenAddress(requireEnv(env, "TRON_USDT_ADDRESS")));
const shareToken = (): Uint8Array =>
  evmAddressBytes(tronTokenAddress(requireEnv(env, "TRON_LEND_SHARE_TOKEN")));

// The share coins this run's supply minted, which the withdraw and the redeem spend.
let mintedShareUnits = 0n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron lend e2e: approve, supply, withdraw shares, redeem after yield",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "preflight: the deployer lists the share token with factor 10^12 and pairs it with the USDT-like TRC-20",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.initialised, "run tests/happy-day-e2e.test.ts first").toBe(true);
        expect(state.tronUsdtAddress, "initialise seals TRON_USDT_ADDRESS").toEqual(underlying());

        await addAllowedTronTokens(
          context,
          resolveTronTokenListings({
            ...env,
            TRON_ALLOWED_TOKENS: [
              requireEnv(env, "TRON_USDT_ADDRESS"),
              requireEnv(env, "TRON_LEND_SHARE_TOKEN"),
            ].join(","),
          }),
        );
        const pair = resolveTronLendPair(env);
        expect(pair, "the setup defaults TRON_LEND_*").toBeDefined();
        if (pair === undefined) return;
        expect([SetTronLendPairOutcome.Set, SetTronLendPairOutcome.AlreadySet]).toContain(
          await setTronLendPair(context, pair),
        );

        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const share = vaultTronTokenConfig(after, shareToken());
        expect(share.factor).toBe(SHARE_FACTOR);
        expect(share.colour).toEqual(pureCircuits.tronCoinColour(shareToken(), SHARE_FACTOR));
        expect(vaultTronTokenConfig(after, underlying()).colour).toEqual(
          pureCircuits.vaultTronTokenDomainSeparator(underlying()),
        );
        expect(after.tronLendUnderlying).toEqual(underlying());
        expect(after.tronLendShareToken).toEqual(shareToken());
        const t = await tron();
        const trx = await getTrxBalance(t.tronRpcUrl, t.tronVaultAddress.bytes);
        expect(trx, `fund ${t.tronVaultAddress.base58} with TRX`).toBeGreaterThanOrEqual(
          after.vaultTronFeeLimits.supply,
        );
      },
      15 * MINUTE,
    );

    it(
      "a Tron USDT-like deposit gives the user the coins the supply surrenders",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const config = vaultTronTokenConfig(state, underlying());
        // Two supplies: the settled one and the one left unsent for its refund.
        const needed = 2n * (SUPPLY_AMOUNT + config.fees.supply);
        const wallet = await session.wallet();
        const color = vaultTronTokenType(config, context.vaultContractAddress);
        const held = (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        if (held < needed) {
          await runTronDepositRoundTrip(session, await tron(), {
            amount: needed - held,
            tokenAddress: underlying(),
          });
        }
        const synced = await waitForFacadeState(
          wallet.facade,
          (balances) => (balances.shielded.balances[color] ?? 0n) >= needed,
        );
        expect(synced.shielded.balances[color] ?? 0n).toBeGreaterThanOrEqual(needed);
      },
      POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "startTronApprove ... completeTronApprove: the USDT-like approve returns true",
      async () => {
        const { outcome, settled } = await runTronApproveRoundTrip(session, await tron(), {});
        expect(settled).toBe(true);
        expect(outcome.succeeded).toBe(true);
        expect(outcome.serializedOutput).toEqual(Uint8Array.of(1));
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "startTronSupply ... completeTronSupply mints the attested shares floored to share coin units",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const underlyingConfig = vaultTronTokenConfig(state, underlying());
        const shareConfig = vaultTronTokenConfig(state, shareToken());
        const wallet = await session.wallet();
        const shareColor = vaultTronTokenType(shareConfig, context.vaultContractAddress);
        const underlyingColor = vaultTronTokenType(underlyingConfig, context.vaultContractAddress);
        const before = (await wallet.facade.waitForSyncedState()).shielded.balances;
        const sharesBefore = before[shareColor] ?? 0n;
        const underlyingBefore = before[underlyingColor] ?? 0n;
        const vaultSharesBefore = await getTrc20Balance(
          t.tronRpcUrl,
          tronAddressFromEvm(shareToken()),
          t.tronVaultAddress.bytes,
        );

        const { requestId, outcome, settled } = await runTronSupplyRoundTrip(session, t, {
          amount: SUPPLY_AMOUNT,
        });

        expect(settled).toBe(true);
        expect(outcome.event.outputKind).toBe(OutputKind.executed);
        const shares = bytesToBigint(outcome.serializedOutput);
        expect(shares, "the shares need more than 64 bits").toBeGreaterThan(2n ** 64n);
        mintedShareUnits = tronAttestedUnits(outcome.serializedOutput, SHARE_FACTOR);
        expect(shares - mintedShareUnits * SHARE_FACTOR).toBeLessThan(SHARE_FACTOR);
        expect(
          await getTrc20Balance(
            t.tronRpcUrl,
            tronAddressFromEvm(shareToken()),
            t.tronVaultAddress.bytes,
          ),
        ).toBe(vaultSharesBefore + shares);
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronSupplyMap.member(requestIdBytes(requestId))).toBe(false);
        await waitForFacadeState(
          wallet.facade,
          (synced) =>
            (synced.shielded.balances[shareColor] ?? 0n) === sharesBefore + mintedShareUnits &&
            (synced.shielded.balances[underlyingColor] ?? 0n) ===
              underlyingBefore - SUPPLY_AMOUNT - underlyingConfig.fees.supply,
        );
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "a withdrawal of share coins moves units·10^12 shares to the recipient on Tron",
      async () => {
        const t = await tron();
        const recipient = tronAddressFromEvm(crypto.getRandomValues(new Uint8Array(20)));
        const { outcome, settled } = await runTronWithdrawRoundTrip(session, t, {
          amount: SHARE_WITHDRAW_UNITS,
          destTronAddress: recipient,
          tokenAddress: shareToken(),
        });
        expect(settled).toBe(true);
        expect(outcome.succeeded).toBe(true);
        expect(
          await getTrc20Balance(t.tronRpcUrl, tronAddressFromEvm(shareToken()), recipient),
        ).toBe(SHARE_WITHDRAW_UNITS * SHARE_FACTOR);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "startTronRedeem ... completeTronRedeem after yield mints more USDT-like coins than supplied",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const shareConfig = vaultTronTokenConfig(state, shareToken());
        const underlyingConfig = vaultTronTokenConfig(state, underlying());
        const redeemShares =
          mintedShareUnits -
          SHARE_WITHDRAW_UNITS -
          shareConfig.fees.withdraw -
          shareConfig.fees.redeem;
        expect(redeemShares, "run the supply and withdraw tests first").toBeGreaterThan(0n);

        const donation = await sendTrc20(
          t.tronRpcUrl,
          t.funder,
          tronAddressFromEvm(underlying()),
          tronAddressFromEvm(shareToken()),
          YIELD_DONATION,
        );
        expect((await waitForTronTransaction(t.tronRpcUrl, donation, MINUTE)).receiptResult).toBe(
          "SUCCESS",
        );

        const wallet = await session.wallet();
        const underlyingColor = vaultTronTokenType(underlyingConfig, context.vaultContractAddress);
        const underlyingBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[underlyingColor] ?? 0n;

        const { requestId, outcome, settled } = await runTronRedeemRoundTrip(session, t, {
          shares: redeemShares,
        });

        expect(settled).toBe(true);
        expect(outcome.event.outputKind).toBe(OutputKind.executed);
        const assets = bytesToBigint(outcome.serializedOutput);
        expect(assets, "the donated yield accrues to the redeemed shares").toBeGreaterThan(
          (redeemShares * SUPPLY_AMOUNT) / mintedShareUnits,
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronRedeemMap.member(requestIdBytes(requestId))).toBe(false);
        await waitForFacadeState(
          wallet.facade,
          (synced) =>
            (synced.shielded.balances[underlyingColor] ?? 0n) ===
            underlyingBefore + tronAttestedUnits(outcome.serializedOutput, underlyingConfig.factor),
        );
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "a supply nobody sent before its window closed to sends is refunded, fee kept",
      async () => {
        const context = await session.vaultContext();
        const t = await tron();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const config = vaultTronTokenConfig(state, underlying());
        const wallet = await session.wallet();
        const color = vaultTronTokenType(config, context.vaultContractAddress);
        const coinsBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        const queued = await queueTronSupply(context, t, {
          amount: SUPPLY_AMOUNT,
          windowMs: REFUND_WINDOW_MS,
        });
        const opensAt = tronRefundOpensAtMs(queued.window.expiration);
        await new Promise((resolve) => setTimeout(resolve, Number(opensAt) - Date.now()));
        await expect(sendTronSupply(context, queued)).rejects.toThrow(/too close/);
        await refundUnsentTronSupply(context, { inIndex: queued.inIndex });

        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.outputRequestBuffer.member(queued.outIndex)).toBe(false);
        expect(after.bidirectionalTronSupplyMap.member(requestIdBytes(queued.requestId))).toBe(
          false,
        );
        await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) === coinsBefore - config.fees.supply,
        );
      },
      Number(REFUND_WINDOW_MS) + 15 * MINUTE,
    );
  },
);
