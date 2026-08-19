// The benchmark e2e flow: every vault circuit proved at least once, so the
// merged report (yarn benchmark:report:erc20-vault) carries a prove row for
// each of the 9 circuits. The sequences, in order:
//
//   initialize     — timed when THIS run initializes the vault (fresh
//                    deploy); the circuit is one-shot per contract, so a
//                    vault initialized by an earlier flow file logs a skip.
//   approve        — approveRouter request + MPC signature + broadcast.
//                    Permissionless and repeatable, so it always runs.
//   deposit        — full round trip ending in claim.
//   withdraw       — full round trip ending in completeWithdraw.
//   swap           — arrange deposit (untimed), then the swap round trip
//                    ending in completeSwap. Needs Uniswap on the EVM chain
//                    (Sepolia or the pinned fork); logs a skip elsewhere,
//                    leaving the swap/completeSwap prove rows absent.
//   refund         — arrange deposit (untimed) + vault ERC20 drain
//                    (fakenet-only), then a withdraw whose transfer mines
//                    and REVERTS, so the MPC attests the fixed failure
//                    output and the settle proves the refund circuit.
//
// Every leg is driven LONG-HAND (one flow call per test) with an explicit
// stopwatch started and stopped around exactly the call under measurement —
// never inside a flow helper, so timing is visible at the call site and
// flows that don't measure never time in the background. One leg per test
// also means a narrowed vitest selection can benchmark the smallest unit on
// its own (just deposit, just claim).
//
// REPORTING ONLY, by design: there is no assertion budget — a regression
// gate needs baseline data first. "Report" means (a) a human-readable
// banner table and (b) one machine-greppable `BENCHMARK_TIMINGS_JSON {...}`
// line per run, so baselines can be scraped from run logs. Each sequence's
// timings stay in SEPARATE records: they share leg names
// (pollSignatureResponse, broadcastEvm, pollRespondBidirectional), so
// merging them would collide. Legs a resumed/rerun pass skipped are absent
// from the report — never fabricated or resume-skewed.
//
// The flow cycles the suite's funds like the happy-day file: each deposit
// sweeps USDC user → vault, the withdraw and the drain send it back. For
// the full 9-circuit table run this file against a FRESH deploy (initialize
// is consumed by whichever file runs it first, and FILE_ORDER puts
// happy-day before this one in a full-suite run). Recovery from a run that
// died mid-flow (proof-server OOM): rerun this file with the
// BENCHMARK_*_REQUEST_ID env var the failed run printed
// (deposit/withdraw/swap/refund-deposit/refund-withdraw).
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.

import { VAULT_SWAP_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  getTransactionNonce,
  logSkip,
  requireEnv as requireEnvOf,
} from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { PROOF_RECORDS_FILE } from "../src/benchmark/paths.ts";
import { Recorder } from "../src/benchmark/recorder.ts";
import { BenchmarkLeg } from "../src/benchmark/records.ts";
import { quoteExactOutputSingle, uniswapAvailable } from "../src/evm-swap.ts";
import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { approveRouter } from "../src/flows/approve.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { claim } from "../src/flows/claim.ts";
import { completeWithdraw } from "../src/flows/complete-withdraw.ts";
import { deposit, runDepositRoundTrip } from "../src/flows/deposit.ts";
import { initialize } from "../src/flows/initialize.ts";
import { pollRespondBidirectional } from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { pollSwapOutcome, settleSwap, swap, type SwapOutcome } from "../src/flows/swap.ts";
import { withdraw } from "../src/flows/withdraw.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset — the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// One recorder per run: every proof-server /check and /prove round trip plus
// each leg's wall clock lands in the JSONL the report generator reads
// (reports/raw/proof-records.jsonl). Inert offline: it touches no files
// until the first record.
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const recorder = new Recorder(PROOF_RECORDS_FILE, runId);

// Wallet facade + vault context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createVaultSession(env, recorder.observer);

// One deposit's worth of value rides the deposit + withdraw round trips:
// deposited, claimed, escrowed, withdrawn — 0.1 USDC. The refund sequence
// arranges its own 0.1 on top (the funding preflight requires both), and the
// swap sequence sizes its arrange deposit from a live quote.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;
const REFUND_AMOUNT = parseUnits("0.1", 6);

// Swap parameters, mirroring tests/swap-e2e.test.ts: receive exactly
// AMOUNT_OUT of EURC, capping the input at a live quote plus headroom (the
// fork pool price is arbitrary, so the cap is never hardcoded).
const SWAP_TOKEN_OUT = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4"; // EURC
const SWAP_FEE = 500n;
const SWAP_AMOUNT_OUT = 1_000_000n; // 1 EURC exact receive
const SWAP_CAP_SLIPPAGE_BPS = 1000n; // 10% over the quote

/**
 * Start a stopwatch. The returned function stops it and returns the elapsed
 * wall-clock milliseconds — so every measurement in this file reads as an
 * explicit start/stop pair bracketing exactly the call being timed.
 *
 * @returns The stop function.
 */
const startTimer = (): (() => number) => {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
};

// The per-leg wall-clock records the report test prints, keyed by flow
// function name and filled by the timed legs below as they run.
const timings: {
  readonly initialize: Record<string, number>;
  readonly approve: Record<string, number>;
  readonly deposit: Record<string, number>;
  readonly withdraw: Record<string, number>;
  readonly swap: Record<string, number>;
  readonly refund: Record<string, number>;
} = { initialize: {}, approve: {}, deposit: {}, withdraw: {}, swap: {}, refund: {} };

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault benchmark e2e: per-leg wall-clock covering every vault circuit",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: user EVM account holds the deposit minimums, vault EVM account holds the withdraw gas budget",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const erc20Address = requireEnv("ERC20_ADDRESS");

        // Same minimums as the happy-day deposit leg: the user's derived
        // account pays the sweep gas and supplies the deposited ERC20.
        const userEth = await getEthBalance(rpcUrl, userAddress);
        console.log(`${userAddress} ETH balance: ${String(userEth)} wei`);
        expect(userEth, `fund ${userAddress} with >= 0.009 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.009"),
        );
        const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
        console.log(
          `${userAddress} balance on ${erc20Address}: ${String(balance)} (decimals ${String(decimals)})`,
        );
        // The main deposit plus the refund sequence's arrange deposit. The
        // swap sequence's arrange deposit is sized from a live quote, so it
        // checks its own funding at quote time.
        expect(
          balance,
          `fund ${userAddress} with >= 0.2 of ERC20 ${erc20Address} on EVM`,
        ).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT + REFUND_AMOUNT);

        // The withdraw tx is sent FROM the vault's derived account, which pays
        // its own gas: require the fee-cap budget of one MPC-signed ERC20
        // transfer, like the happy-day withdraw leg.
        const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS;
        const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
        console.log(
          `${vaultAddress} ETH balance: ${String(vaultEth)} wei (withdraw gas budget: ${String(gasBudget)} wei)`,
        );
        expect(
          vaultEth,
          `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
        ).toBeGreaterThanOrEqual(gasBudget);
      },
      MINUTE,
    );

    it(
      "time initialize: seal the vault config (skips when an earlier flow already initialized)",
      async () => {
        const context = await session.vaultContext();
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // initialize is one-shot per contract: in a full-suite run happy-day
        // (FILE_ORDER-first) has already consumed it, so its prove is only
        // recorded when this file runs against a fresh deploy.
        if ((await readLedger()).initialized) {
          logSkip("initialize", "vault already initialized (an earlier flow file ran it)");
          return;
        }

        recorder.setLeg(BenchmarkLeg.Initialize);
        const stop = startTimer();
        await initialize(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnv("MPC_RESPONSE_KEY"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.initialize.initialize = ms;
        recorder.recordLeg(BenchmarkLeg.Initialize, ms);

        expect((await readLedger()).initialized, "initialize must set the initialized flag").toBe(
          1n,
        );
      },
      15 * MINUTE,
    );

    // ── Approve leg: approveRouter request → MPC signature → broadcast ─────
    // Sign-only (no settle circuit); permissionless and repeatable, so it
    // always runs and always records an approveRouter prove. A repeat approve
    // just re-sets the same allowance.

    // Populated by the request leg below for the sign + broadcast legs.
    let approveRequestId: RequestIdHex;

    it(
      "time approveRouter: record the router-allowance request on the vault ledger",
      async () => {
        const context = await session.vaultContext();
        // The approve tx is sent FROM the vault's derived account; its next
        // nonce comes from the chain, fetched outside the timed span.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.ApproveRequest);
        const stop = startTimer();
        approveRequestId = await approveRouter(context, evmNonce);
        const ms = stop();
        recorder.clearLeg();
        timings.approve.approveRouter = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveRequest, ms);

        expect(approveRequestId).toMatch(/^[0-9a-f]{64}$/);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedApproveTransaction: Transaction;

    it(
      "time pollSignatureResponse (approve): the MPC signs the approve",
      async () => {
        expect(approveRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Approvals are signed by the VAULT's derived account.
        recorder.setLeg(BenchmarkLeg.ApprovePollSignatureResponse);
        const stop = startTimer();
        signedApproveTransaction = await pollSignatureResponse(context, {
          requestId: approveRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.approve.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.ApprovePollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (approve): the approve mines on the EVM",
      async () => {
        expect(signedApproveTransaction).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.ApproveBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedApproveTransaction });
        const ms = stop();
        recorder.clearLeg();
        timings.approve.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    // ── Deposit round trip, one timed leg per test ─────────────────────────

    // Populated by the request leg (or BENCHMARK_DEPOSIT_REQUEST_ID) for the
    // subsequent deposit stages.
    let depositRequestId: RequestIdHex;

    it(
      "time deposit: record the deposit request on the vault ledger",
      async () => {
        if (env.BENCHMARK_DEPOSIT_REQUEST_ID) {
          depositRequestId = env.BENCHMARK_DEPOSIT_REQUEST_ID as RequestIdHex;
          logSkip(
            "deposit",
            `BENCHMARK_DEPOSIT_REQUEST_ID present, resuming deposit '${depositRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        // The sweep tx sender is the user's derived EVM account; its next
        // nonce comes from the chain — fetched OUTSIDE the timed span, which
        // brackets only the flow call under measurement.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_USER_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.DepositRequest);
        const stop = startTimer();
        depositRequestId = await deposit(context, { amount: DEPOSIT_AMOUNT, evmNonce });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.deposit = ms;
        recorder.recordLeg(BenchmarkLeg.DepositRequest, ms);

        expect(depositRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Benchmark deposit request recorded on the vault ledger:`,
          "",
          `  request id: ${depositRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_DEPOSIT_REQUEST_ID=${depositRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedDepositSweepTransaction: Transaction;

    it(
      "time pollSignatureResponse (deposit): the MPC signs the sweep",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Deposit sweeps are signed by the USER's derived account.
        recorder.setLeg(BenchmarkLeg.DepositPollSignatureResponse);
        const stop = startTimer();
        signedDepositSweepTransaction = await pollSignatureResponse(context, {
          requestId: depositRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_USER_ADDRESS"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.DepositPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (deposit): the sweep mines on the EVM",
      async () => {
        expect(signedDepositSweepTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm waits for one confirmation and throws if the tx
        // reverted; on a resumed run an already-mined sweep short-circuits.
        recorder.setLeg(BenchmarkLeg.DepositBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedDepositSweepTransaction });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.DepositBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    it(
      "time pollRespondBidirectional (deposit): the MPC attests the sweep as succeeded",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.DepositPollRespondBidirectional);
        const stop = startTimer();
        const attestation = await pollRespondBidirectional(context, {
          requestId: depositRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.pollRespondBidirectional = ms;
        recorder.recordLeg(BenchmarkLeg.DepositPollRespondBidirectional, ms);

        // The claim below can only mint from a success attestation.
        expect(attestation.succeeded, "the MPC must attest the deposit sweep as succeeded").toBe(
          true,
        );
      },
      5 * MINUTE,
    );

    it(
      "time claim: verify the attestation in-circuit and consume the request",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(depositRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // claimed this request the entry is gone and claim would reject
        // with "Request not found" — skip cleanly instead.
        const before = await readLedger();
        if (!before.signBidirectionalEventMap.member(requestKey)) {
          logSkip("claim", `request ${depositRequestId} already claimed (not on the ledger)`);
          return;
        }

        recorder.setLeg(BenchmarkLeg.DepositClaim);
        const stop = startTimer();
        await claim(context, { requestId: depositRequestId });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.claim = ms;
        recorder.recordLeg(BenchmarkLeg.DepositClaim, ms);

        const after = await readLedger();
        expect(
          after.signBidirectionalEventMap.member(requestKey),
          "claim must consume the request from the ledger",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // ── Withdraw round trip, one timed leg per test ────────────────────────

    // Populated by the request leg (or BENCHMARK_WITHDRAW_REQUEST_ID) for the
    // subsequent withdraw stages.
    let withdrawRequestId: RequestIdHex;

    it(
      "time withdraw: escrow the claimed shielded vault tokens",
      async () => {
        if (env.BENCHMARK_WITHDRAW_REQUEST_ID) {
          withdrawRequestId = env.BENCHMARK_WITHDRAW_REQUEST_ID as RequestIdHex;
          logSkip(
            "withdraw",
            `BENCHMARK_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        // The withdraw tx sender is the VAULT's derived EVM account; the
        // destination is the user's derived account, so the funds cycle. The
        // nonce fetch stays outside the timed span.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );
        const destEvmAddress = requireEnv("EVM_USER_ADDRESS");

        recorder.setLeg(BenchmarkLeg.WithdrawRequest);
        const stop = startTimer();
        withdrawRequestId = await withdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress,
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.withdraw = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawRequest, ms);

        expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Benchmark withdraw request recorded on the vault ledger:`,
          "",
          `  request id: ${withdrawRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedWithdrawTransaction: Transaction;

    it(
      "time pollSignatureResponse (withdraw): the MPC signs the transfer",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Withdraw transfers are signed by the VAULT's derived account.
        recorder.setLeg(BenchmarkLeg.WithdrawPollSignatureResponse);
        const stop = startTimer();
        signedWithdrawTransaction = await pollSignatureResponse(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (withdraw): the transfer mines on the EVM",
      async () => {
        expect(signedWithdrawTransaction).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.WithdrawBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedWithdrawTransaction });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    it(
      "time pollRespondBidirectional (withdraw): the MPC attests the transfer as succeeded",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.WithdrawPollRespondBidirectional);
        const stop = startTimer();
        const attestation = await pollRespondBidirectional(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.pollRespondBidirectional = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawPollRespondBidirectional, ms);

        // Happy-path benchmark: the broadcast leg saw the transfer mine, so
        // the MPC must attest success (the 1-byte 0x01 result).
        expect(
          attestation.succeeded,
          "the MPC must attest the withdraw transfer as succeeded",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "time completeWithdraw: settle the withdrawal and consume the request + refund marker",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(withdrawRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this request the pending-withdrawal marker is gone and
        // completeWithdraw would reject with "Withdrawal not found" — skip
        // cleanly instead.
        const before = await readLedger();
        if (!before.refundCommitment.member(requestKey)) {
          logSkip(
            "completeWithdraw",
            `withdrawal ${withdrawRequestId} already settled (no pending marker on the ledger)`,
          );
          return;
        }

        recorder.setLeg(BenchmarkLeg.WithdrawCompleteWithdraw);
        const stop = startTimer();
        await completeWithdraw(context, { requestId: withdrawRequestId });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.completeWithdraw = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawCompleteWithdraw, ms);

        const after = await readLedger();
        expect(
          after.signBidirectionalEventMap.member(requestKey),
          "completeWithdraw must consume the request from the ledger",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // ── Swap round trip, one timed leg per test ────────────────────────────
    // Needs Uniswap on the EVM chain (Sepolia or the pinned fork): the first
    // test resolves availability once and the rest skip with it, leaving the
    // swap/completeSwap prove rows absent on a bare-anvil stack.

    let swapAvailable = false;
    let swapAmountInMaximum: bigint;
    let swapRequestId: RequestIdHex;

    it(
      "swap arrange: quote the cap and deposit the tokenIn coin the swap will surrender (untimed)",
      async () => {
        const context = await session.vaultContext();
        swapAvailable = await uniswapAvailable(context.evmRpcUrl);
        if (!swapAvailable) {
          logSkip(
            "swap",
            "Uniswap not deployed on this EVM chain (need Sepolia or a Sepolia fork)",
          );
          return;
        }
        if (env.BENCHMARK_SWAP_REQUEST_ID) {
          logSkip("swap arrange", "BENCHMARK_SWAP_REQUEST_ID present, resuming past the arrange");
          return;
        }

        // The deposited coin IS the coin the swap surrenders, so it must
        // equal the amountInMaximum the swap burns — sized from a live quote
        // (the fork pool price is arbitrary), as in tests/swap-e2e.test.ts.
        const { amountInMaximum } = await quoteExactOutputSingle(
          context.evmRpcUrl,
          context.erc20Address,
          SWAP_TOKEN_OUT,
          SWAP_FEE,
          SWAP_AMOUNT_OUT,
          SWAP_CAP_SLIPPAGE_BPS,
        );
        swapAmountInMaximum = amountInMaximum;
        expect(swapAmountInMaximum).toBeGreaterThan(0n);
        // Arrange-stage plumbing, deliberately untimed: its deposit/claim
        // proves still land in the recorder as extra warm samples.
        const { requestId } = await runDepositRoundTrip(session, { amount: amountInMaximum });
        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      30 * MINUTE,
    );

    it(
      "time swap: record the swap request on the vault ledger",
      async () => {
        if (!swapAvailable) {
          logSkip("swap", "Uniswap not available (see the arrange leg)");
          return;
        }
        if (env.BENCHMARK_SWAP_REQUEST_ID) {
          swapRequestId = env.BENCHMARK_SWAP_REQUEST_ID as RequestIdHex;
          logSkip("swap", `BENCHMARK_SWAP_REQUEST_ID present, resuming swap '${swapRequestId}'`);
          return;
        }
        expect(swapAmountInMaximum).toBeDefined();

        const context = await session.vaultContext();
        // The swap tx is sent FROM the vault's derived account (it holds the
        // pooled funds); the nonce fetch stays outside the timed span.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.SwapRequest);
        const stop = startTimer();
        swapRequestId = await swap(context, {
          tokenOut: SWAP_TOKEN_OUT,
          fee: SWAP_FEE,
          amountOut: SWAP_AMOUNT_OUT,
          amountInMaximum: swapAmountInMaximum,
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.swap.swap = ms;
        recorder.recordLeg(BenchmarkLeg.SwapRequest, ms);

        expect(swapRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Benchmark swap request recorded on the vault ledger:`,
          "",
          `  request id: ${swapRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_SWAP_REQUEST_ID=${swapRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedSwapTransaction: Transaction;

    it(
      "time pollSignatureResponse (swap): the MPC signs the swap",
      async () => {
        if (!swapAvailable) {
          logSkip("swap", "Uniswap not available (see the arrange leg)");
          return;
        }
        expect(swapRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Swaps are signed by the VAULT's derived account, read from the
        // vault's SWAP ledger map (field 11).
        recorder.setLeg(BenchmarkLeg.SwapPollSignatureResponse);
        const stop = startTimer();
        signedSwapTransaction = await pollSignatureResponse(context, {
          requestId: swapRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_SWAP_REQUESTS_PATH,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.swap.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.SwapPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (swap): the swap mines on the EVM",
      async () => {
        if (!swapAvailable) {
          logSkip("swap", "Uniswap not available (see the arrange leg)");
          return;
        }
        expect(signedSwapTransaction).toBeDefined();
        const context = await session.vaultContext();

        // tolerateRevert: an on-chain revert is a valid outcome the MPC
        // attests as a failure — the settle would then route to refund, which
        // the settle leg below rejects as an unexpected benchmark outcome.
        recorder.setLeg(BenchmarkLeg.SwapBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedSwapTransaction, tolerateRevert: true });
        const ms = stop();
        recorder.clearLeg();
        timings.swap.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.SwapBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    // Populated by the poll leg below for the settle leg.
    let swapOutcome: SwapOutcome;

    it(
      "time pollSwapOutcome: the MPC attests the swap's amountIn",
      async () => {
        if (!swapAvailable) {
          logSkip("swap", "Uniswap not available (see the arrange leg)");
          return;
        }
        expect(swapRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.SwapPollOutcome);
        const stop = startTimer();
        swapOutcome = await pollSwapOutcome(context, {
          requestId: swapRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.swap.pollSwapOutcome = ms;
        recorder.recordLeg(BenchmarkLeg.SwapPollOutcome, ms);

        // The settle below must prove completeSwap, not refund: the swap
        // round trip is the happy path (the refund sequence owns the
        // refund circuit's benchmark).
        expect(
          swapOutcome.matchedFailureOutput,
          "the MPC must attest the swap as executed (amountIn), not the failure output",
        ).toBe(false);
      },
      5 * MINUTE,
    );

    it(
      "time completeSwap: settle the swap and consume the request + swap marker",
      async () => {
        if (!swapAvailable) {
          logSkip("swap", "Uniswap not available (see the arrange leg)");
          return;
        }
        expect(swapRequestId).toBeDefined();
        expect(swapOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(swapRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this swap the pending-swap marker is gone — skip cleanly.
        const before = await readLedger();
        if (!before.swapRefundCommitment.member(requestKey)) {
          logSkip("completeSwap", `swap ${swapRequestId} already settled (no pending marker)`);
          return;
        }

        recorder.setLeg(BenchmarkLeg.SwapSettle);
        const stop = startTimer();
        const settled = await settleSwap(context, swapRequestId, swapOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.swap.completeSwap = ms;
        recorder.recordLeg(BenchmarkLeg.SwapSettle, ms);

        expect(settled.refunded, "the happy-path swap must settle through completeSwap").toBe(
          false,
        );
        const after = await readLedger();
        expect(
          after.swapEventMap.member(requestKey),
          "completeSwap must consume the request from the swap ledger map",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // ── Refund sequence, one timed leg per test ────────────────────────────
    // The deposit-withdrawal-failure recipe (see
    // tests/deposit-withdrawal-failure-refund.test.ts): drain the vault's
    // EVM ERC20 balance so the withdraw transfer mines and REVERTS, the MPC
    // attests the fixed 5-byte failure output, and the settle proves the
    // refund circuit. Works on any stack (no Uniswap needed); the drain is
    // fakenet-only, like the source recipe.

    it(
      "refund arrange: deposit round trip mints the tokens the doomed withdraw will escrow (untimed)",
      async () => {
        if (env.BENCHMARK_REFUND_WITHDRAW_REQUEST_ID) {
          logSkip(
            "refund arrange",
            "BENCHMARK_REFUND_WITHDRAW_REQUEST_ID present, resuming past the arrange",
          );
          return;
        }
        // Arrange-stage plumbing, deliberately untimed (extra warm samples).
        const { requestId } = await runDepositRoundTrip(session, {
          amount: REFUND_AMOUNT,
          reuseRequestId: env.BENCHMARK_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Refund-arrange deposit ${requestId} complete.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      15 * MINUTE,
    );

    it(
      "refund arrange: drain the vault's EVM ERC20 balance (fakenet-only) so the withdraw transfer must revert",
      async () => {
        if (env.BENCHMARK_REFUND_WITHDRAW_REQUEST_ID) {
          logSkip("drain", "BENCHMARK_REFUND_WITHDRAW_REQUEST_ID present, resuming past the drain");
          return;
        }
        const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"));
        if (drained === 0n) {
          logSkip("drain", "the vault's derived account already holds no ERC20");
        }

        const { balance } = await getErc20Balance(
          requireEnv("EVM_RPC_URL"),
          requireEnv("ERC20_ADDRESS"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );
        expect(
          balance,
          `the vault must hold NO ERC20 so the ${String(REFUND_AMOUNT)}-unit transfer reverts`,
        ).toBe(0n);
      },
      3 * MINUTE,
    );

    // Populated by the request leg (or BENCHMARK_REFUND_WITHDRAW_REQUEST_ID)
    // for the subsequent stages.
    let refundWithdrawRequestId: RequestIdHex;

    it(
      "time withdraw (refund): escrow tokens for a transfer the vault cannot pay",
      async () => {
        if (env.BENCHMARK_REFUND_WITHDRAW_REQUEST_ID) {
          refundWithdrawRequestId = env.BENCHMARK_REFUND_WITHDRAW_REQUEST_ID as RequestIdHex;
          logSkip(
            "withdraw",
            `BENCHMARK_REFUND_WITHDRAW_REQUEST_ID present, resuming withdraw '${refundWithdrawRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        // Nonce fetched AFTER the drain mined (the drain consumed one).
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.RefundWithdraw);
        const stop = startTimer();
        refundWithdrawRequestId = await withdraw(context, {
          amount: REFUND_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.withdraw = ms;
        recorder.recordLeg(BenchmarkLeg.RefundWithdraw, ms);

        expect(refundWithdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Doomed withdraw request recorded on the vault ledger:`,
          "",
          `  request id: ${refundWithdrawRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_REFUND_WITHDRAW_REQUEST_ID=${refundWithdrawRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedDoomedWithdrawTransaction: Transaction;

    it(
      "time pollSignatureResponse (refund): the MPC signs the doomed transfer",
      async () => {
        expect(refundWithdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.RefundPollSignatureResponse);
        const stop = startTimer();
        signedDoomedWithdrawTransaction = await pollSignatureResponse(context, {
          requestId: refundWithdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.RefundPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (refund): the doomed transfer mines and REVERTS",
      async () => {
        expect(signedDoomedWithdrawTransaction).toBeDefined();
        const context = await session.vaultContext();

        // The transfer exceeds the vault's (zero) ERC20 balance: it mines
        // with `status 0` and broadcastEvm surfaces that as its
        // reverted-on-chain error — the mined receipt is what the responder
        // attests the failure output from.
        recorder.setLeg(BenchmarkLeg.RefundBroadcastEvm);
        const stop = startTimer();
        await expect(
          broadcastEvm(context, { transaction: signedDoomedWithdrawTransaction }),
        ).rejects.toThrow(/reverted on-chain/);
        const ms = stop();
        recorder.clearLeg();
        timings.refund.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.RefundBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    it(
      "time pollRespondBidirectional (refund): the MPC attests the transfer as FAILED",
      async () => {
        expect(refundWithdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.RefundPollRespondBidirectional);
        const stop = startTimer();
        const attestation = await pollRespondBidirectional(context, {
          requestId: refundWithdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.pollRespondBidirectional = ms;
        recorder.recordLeg(BenchmarkLeg.RefundPollRespondBidirectional, ms);

        // Only the fixed failure output routes the settle to the refund
        // circuit — the whole point of this sequence.
        expect(
          attestation.matchedFailureOutput,
          "a mined revert must be attested as the fixed MPC failure output",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "time refund: settle the doomed withdrawal through the refund circuit",
      async () => {
        expect(refundWithdrawRequestId).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(refundWithdrawRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this request the pending-withdrawal marker is gone — skip
        // cleanly instead.
        const before = await readLedger();
        if (!before.refundCommitment.member(requestKey)) {
          logSkip(
            "refund",
            `withdrawal ${refundWithdrawRequestId} already settled (no pending marker on the ledger)`,
          );
          return;
        }

        // The settle flow routes the failure output to the refund circuit
        // (see src/flows/complete-withdraw.ts) — the prove this leg exists
        // to record.
        recorder.setLeg(BenchmarkLeg.RefundSettle);
        const stop = startTimer();
        await completeWithdraw(context, { requestId: refundWithdrawRequestId });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.refund = ms;
        recorder.recordLeg(BenchmarkLeg.RefundSettle, ms);

        const after = await readLedger();
        expect(
          after.refundCommitment.member(requestKey),
          "refund must consume the pending-withdrawal marker",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    it(
      "report: per-leg wall clock of every sequence",
      () => {
        // Legs a resumed/rerun/skipped pass never ran are simply absent —
        // the report never fabricates a number for work this run did not do.
        const section = (label: string, record: Record<string, number>): string[] => {
          const rows = Object.entries(record).map(
            ([leg, ms]) => `  ${`${label}.${leg}`.padEnd(44)}${String(ms).padStart(9)} ms`,
          );
          return rows.length > 0
            ? rows
            : [`  ${label}: (every leg skipped — resumed, rerun, or unavailable)`];
        };

        banner([
          "Benchmark report — per-leg wall clock:",
          "",
          ...section("initialize", timings.initialize),
          ...section("approve", timings.approve),
          ...section("deposit", timings.deposit),
          ...section("withdraw", timings.withdraw),
          ...section("swap", timings.swap),
          ...section("refund", timings.refund),
        ]);

        // The machine-readable twin of the banner, one line per run, for
        // scraping baselines out of run logs.
        console.log(`BENCHMARK_TIMINGS_JSON ${JSON.stringify(timings)}`);

        // The report covers every sequence, whichever legs this run executed.
        expect(Object.keys(timings)).toEqual([
          "initialize",
          "approve",
          "deposit",
          "withdraw",
          "swap",
          "refund",
        ]);
      },
      MINUTE,
    );
  },
);
