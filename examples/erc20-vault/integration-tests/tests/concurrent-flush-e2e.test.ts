// The concurrent-flush e2e flow: two wallets flush the same queued item at once, and the
// user's own transactions still never fail. The user wallet runs a deposit round trip while
// a second funded wallet (the `bearer` role wallet) flushes every item the user queues. Both
// flushes carry the same item, so one lands and the other loses: it lands as `FailFallible`
// when it was built before the winner landed, and fails to build on a `flushQueue` assert
// when it was built after. The SDK's `flushUntil` catches either before going round again.
// The race runs twice: on the deposit request's flush and on its attestation's flush.
//
// Load limits: two submitting wallets, each with at most one transaction unconfirmed at a
// time. Node error 170 (InvalidDustSpendProof) has left a loaded local stack rejecting every
// later submission, so a 170 fails the spec at once with the harness's reset hint, and after
// the race a lone deposit start from the user wallet runs as a canary. FILE_ORDER pins this
// file last, so a poisoned stack fails no other spec, and it is not a CI gate spec.
//
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID / CONCURRENT_FLUSH_CANARY_REQUEST_ID set to the ids the
// failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions (src/flows/),
// in-process, never a subprocess.
import { bytesToHex, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_DEPOSIT_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  banner,
  explainDustSpendRejection,
  getErc20Balance,
  getEthBalance,
  getTransactionNonce,
  logSkip,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { formatUnits, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it, vi } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleDeposit } from "../src/flows/complete-deposit.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startDeposit } from "../src/flows/start-deposit.ts";
import { flushUntil } from "../src/flows/vault-queue.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { sleepUnlessAborted } from "../src/sleep-unless-aborted.ts";
import type { VaultContext } from "../src/vault-context.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset: the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// The user wallet's session: it owns every request this file starts.
const session = createVaultSession(env);

// The second wallet's seed AND identity secret: the `bearer` role wallet, which the setup
// funds with dust-registered NIGHT so it can pay for flushes. Both variables are overridden
// together, as in the bearer-transfer flow. Read leniently at module scope: offline the
// injected env is empty and the suite skips before any test touches it.
const SECOND_WALLET_SEED = env.BEARER_SEED ?? "";

const secondSession = createVaultSession({
  ...env,
  USER_SEED: SECOND_WALLET_SEED,
  VAULT_USER_SECRET_KEY: SECOND_WALLET_SEED,
});

// Each of the two deposits (the raced one and the canary) moves 0.1 USDC.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);

// The second wallet's flusher. It flushes every item queued after it starts, carrying those
// items first, until `stop` aborts. Items already waiting when it starts are left to others,
// as an identical repeat of an open deposit waits there and never moves. It polls once a
// second, and a flush takes about 20 s from build to landing, so it builds against the same
// state as the user's own flush of the same item: both carry that item, and one loses.
async function flushAlongside(context: VaultContext, stop: AbortSignal): Promise<void> {
  const read = () =>
    readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
  const before = await read();
  const seenIndexes = new Set([...before.inputRequestBuffer].map(([inIndex]) => inIndex));
  const seenRequestIds = new Set(
    [...before.inputAttestationBuffer].map(([requestId]) => bytesToHex(requestId)),
  );
  while (!stop.aborted) {
    const state = await read();
    const inIndexes = [...state.inputRequestBuffer]
      .map(([inIndex]) => inIndex)
      .filter((inIndex) => !seenIndexes.has(inIndex));
    const requestIds = [...state.inputAttestationBuffer]
      .map(([requestId]) => requestId)
      .filter((requestId) => !seenRequestIds.has(bytesToHex(requestId)));
    if (inIndexes.length + requestIds.length > 0) {
      inIndexes.forEach((inIndex) => seenIndexes.add(inIndex));
      requestIds.forEach((requestId) => seenRequestIds.add(bytesToHex(requestId)));
      console.log(
        `second wallet: flushing ${String(inIndexes.length)} request(s) and ${String(requestIds.length)} attestation(s) the user queued`,
      );
      await flushUntil(
        context,
        (flushed) =>
          inIndexes.every((inIndex) => !flushed.inputRequestBuffer.member(inIndex)) &&
          requestIds.every((requestId) => !flushed.inputAttestationBuffer.member(requestId)),
        { inIndexes, requestIds },
      );
    }
    await sleepUnlessAborted(1_000, stop);
  }
}

// The SDK's flushUntil logs this line each time one of its flushes loses a race (lands as
// FailFallible or fails to build on a flushQueue assert), then goes round again: counting it
// is how this file observes a lost race.
const LOST_RACE_LOG = "lost a race to another flush";

/** What {@link withSecondFlusher} hands back. */
interface SecondFlusherOutcome<T> {
  /** What the user wallet's `requester` resolved to. */
  readonly result: T;
  /** How many flushes, of either wallet, lost a race and went round again meanwhile. */
  readonly lostRaces: number;
}

// Runs `requester` on the user wallet while the second wallet flushes alongside it, and
// fails as soon as either side fails.
async function withSecondFlusher<T>(
  what: string,
  requester: () => Promise<T>,
): Promise<SecondFlusherOutcome<T>> {
  const secondContext = await secondSession.vaultContext();
  const consoleLog = vi.spyOn(console, "log");
  try {
    const stop = new AbortController();
    const flusher = flushAlongside(secondContext, stop.signal);
    const requested = requester().finally(() => {
      stop.abort();
    });
    const [result] = await explainDustSpendRejection(what, () => Promise.all([requested, flusher]));
    const lostRaces = consoleLog.mock.calls.filter(([line]) =>
      String(line).includes(LOST_RACE_LOG),
    ).length;
    return { result, lostRaces };
  } finally {
    consoleLog.mockRestore();
  }
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault concurrent-flush e2e: two wallets flush the same items, user transactions never fail",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await secondSession.stop();
    });

    it(
      "funding preflight: check the user EVM account holds ETH and the ERC20 for two deposits",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const erc20Address = requireEnv("ERC20_ADDRESS");

        const ethBalance = await getEthBalance(rpcUrl, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(ethBalance, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
        );
        expect(ethBalance, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.01"),
        );

        const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(balance, 2n * DEPOSIT_AMOUNT, decimals, erc20Address)}`,
        );
        expect(
          balance,
          `fund ${userAddress} with >= ${formatUnits(2n * DEPOSIT_AMOUNT, decimals)} of ERC20 ${erc20Address} on EVM`,
        ).toBeGreaterThanOrEqual(2n * DEPOSIT_AMOUNT);
      },
      MINUTE,
    );

    it(
      "wallets: both wallets sync and join the initialised vault as distinct identities",
      async () => {
        expect(
          SECOND_WALLET_SEED,
          "the setup must resolve BEARER_SEED, the second wallet",
        ).not.toBe("");
        const context = await session.vaultContext();
        const secondContext = await secondSession.vaultContext();
        expect(secondContext.identity.commitmentHex).not.toBe(context.identity.commitmentHex);

        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.initialised, "run happy-day-e2e first: it initialises the vault").toBe(true);
      },
      15 * MINUTE,
    );

    // Flushes that lost a race during the two race stages, summed for the race outcome stage.
    let lostRaces = 0;

    // Populated by the start stage (or CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID) for the later
    // deposit stages.
    let depositRequestId: RequestIdHex;

    it(
      "startDeposit beside a second flusher: the user's start, flush and send succeed while both wallets flush the request",
      async () => {
        if (env.CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID) {
          depositRequestId = env.CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID as RequestIdHex;
          logSkip(
            "startDeposit",
            `CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID present, resuming deposit '${depositRequestId}'`,
          );
          return;
        }
        const context = await session.vaultContext();
        const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmUserAddress);
        const raced = await withSecondFlusher("startDeposit beside a second flusher", () =>
          startDeposit(context, { amount: DEPOSIT_AMOUNT, evmNonce }),
        );
        depositRequestId = raced.result;
        lostRaces += raced.lostRaces;
        expect(depositRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Deposit ${depositRequestId} started, flushed and sent.`,
          "",
          `Flushes that lost a race in this stage: ${String(raced.lostRaces)}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  CONCURRENT_FLUSH_DEPOSIT_REQUEST_ID=${depositRequestId}`,
        ]);
      },
      10 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedSweepTransaction: Transaction;

    it(
      "pollSignatureResponse: poll signet contract for the deposit sweep's signature response",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();
        signedSweepTransaction = await pollSignatureResponse(context, {
          requestId: depositRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: context.evmUserAddress,
          requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
        });
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast deposit sweep evm txn: broadcast to evm",
      async () => {
        expect(signedSweepTransaction).toBeDefined();
        const context = await session.vaultContext();
        const receipt = await broadcastEvm(context, { transaction: signedSweepTransaction });
        console.log(`deposit sweep mined: ${receipt.hash} (block ${String(receipt.blockNumber)})`);
      },
      2 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let depositOutcome: RespondOutcome;

    it(
      "pollRespondBidirectional: poll signet contract for the deposit sweep's attestation",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();
        depositOutcome = await pollRespondBidirectional(context, {
          requestId: depositRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
        });
        expect(depositOutcome.succeeded, "the MPC must attest the mined sweep as succeeded").toBe(
          true,
        );
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "settleDeposit beside a second flusher: the user's queue and complete succeed while both wallets flush the attestation",
      async () => {
        expect(depositOutcome).toBeDefined();
        const context = await session.vaultContext();
        const isRequestOpen = async () =>
          (
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            )
          ).bidirectionalDepositMap.member(requestIdBytes(depositRequestId));

        if (!(await isRequestOpen())) {
          logSkip("settleDeposit", `deposit ${depositRequestId} already settled`);
          return;
        }
        const raced = await withSecondFlusher("settleDeposit beside a second flusher", () =>
          settleDeposit(context, depositOutcome),
        );
        lostRaces += raced.lostRaces;

        expect(await isRequestOpen(), "completeDeposit must consume the request").toBe(false);
        banner([
          `Deposit ${depositRequestId} settled.`,
          "",
          `Flushes that lost a race in this stage: ${String(raced.lostRaces)}`,
        ]);
      },
      15 * MINUTE,
    );

    it("race outcome: a flush lost a race to the other wallet's flush and flushUntil went round again", () => {
      expect(
        lostRaces,
        "both wallets flushed the same items, so a flush must have lost the race and been retried",
      ).toBeGreaterThanOrEqual(1);
    });

    // Populated by the canary stage (or CONCURRENT_FLUSH_CANARY_REQUEST_ID) for the closing
    // stage.
    let canaryRequestId: RequestIdHex;

    it(
      "canary: a lone deposit start from the user wallet succeeds after the race",
      async () => {
        if (env.CONCURRENT_FLUSH_CANARY_REQUEST_ID) {
          canaryRequestId = env.CONCURRENT_FLUSH_CANARY_REQUEST_ID as RequestIdHex;
          logSkip(
            "canary startDeposit",
            `CONCURRENT_FLUSH_CANARY_REQUEST_ID present, resuming deposit '${canaryRequestId}'`,
          );
          return;
        }
        const context = await session.vaultContext();
        const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmUserAddress);
        try {
          canaryRequestId = await explainDustSpendRejection("canary startDeposit", () =>
            startDeposit(context, { amount: DEPOSIT_AMOUNT, evmNonce }),
          );
        } catch (error) {
          throw new Error(
            `stack poisoned: reset it. The user wallet's deposit start failed after the concurrent flushes: ${String(error)}`,
            { cause: error },
          );
        }
        expect(canaryRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Canary deposit ${canaryRequestId} started, flushed and sent: the stack is healthy.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  CONCURRENT_FLUSH_CANARY_REQUEST_ID=${canaryRequestId}`,
        ]);
      },
      10 * MINUTE,
    );

    it(
      "close the canary: its deposit round trip completes, leaving none of this file's requests open",
      async () => {
        expect(canaryRequestId).toBeDefined();
        const context = await session.vaultContext();

        await explainDustSpendRejection("canary deposit round trip", () =>
          runDepositRoundTrip(session, { amount: DEPOSIT_AMOUNT, reuseRequestId: canaryRequestId }),
        );

        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(
          state.bidirectionalDepositMap.member(requestIdBytes(canaryRequestId)),
          "completeDeposit must consume the canary request",
        ).toBe(false);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );
  },
);
