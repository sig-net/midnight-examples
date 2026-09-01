// The benchmark e2e flow: the merged report (yarn benchmark:report:erc20-vault)
// carries a prove row for each of the 14 circuits the sequences below prove
// (of the contract's 17: refundSwap, refundSupply and refundRedeem are proved
// by the swap-refund, supply-refund and redeem-refund specs). The sequences, in order:
//
//   initialise     : timed when THIS run initialises the vault (fresh
//                    deploy); the circuit is one-shot per contract, so a
//                    vault initialised by an earlier flow file logs a skip.
//   approve        : approveRouter request + MPC signature + broadcast.
//                    Permissionless and repeatable, so it always runs.
//   deposit        : full round trip ending in completeDeposit.
//   withdraw       : full round trip ending in completeWithdraw.
//   swap           : arrange deposit (untimed), then the swap round trip
//                    ending in completeSwap. The setup pipeline verifies the
//                    Uniswap router is on the fork, so it always runs.
//   approveStata   : approveStata request + MPC signature + broadcast, the
//                    aave twin of the approve sequence. The setup pipeline
//                    verifies the stataUSDC wrapper is on the fork, so it and
//                    the two sequences below always run.
//   supply         : arrange deposit of the Aave underlying (untimed), then
//                    the supply round trip ending in completeSupply.
//   redeem         : redeems the shares the supply sequence minted, ending
//                    in completeRedeem.
//   refund         : arrange deposit (untimed) + vault ERC20 drain
//                    (fakenet-only), then a withdraw whose transfer mines
//                    and REVERTS, so the MPC attests the fixed failure
//                    output and the settle proves refundWithdraw.
//
// Every leg is driven LONG-HAND (one flow call per test) with an explicit
// stopwatch started and stopped around exactly the call under measurement —
// never inside a flow helper, so timing is visible at the call site and
// flows that don't measure never time in the background. One leg per test
// also means a narrowed vitest selection can benchmark the smallest unit on
// its own (just startDeposit, just completeDeposit).
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
// sweeps USDC user → vault, the withdraw and the drain send it back. The
// initialise row lands only when this file runs against a FRESH deploy:
// initialise is consumed by whichever file runs it first, and FILE_ORDER
// puts happy-day before this one in a full-suite run. Recovery from a run that
// died mid-flow (proof-server OOM): rerun this file with the
// BENCHMARK_*_REQUEST_ID env var the failed run printed
// (deposit/withdraw/swap/supply/redeem/refund-deposit/refund-withdraw).
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.

import {
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_REDEEM_REQUESTS_PATH,
  VAULT_SUPPLY_REQUESTS_PATH,
  VAULT_SWAP_REQUESTS_PATH,
} from "@midnight-examples/erc20-vault-contract";
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
import { AAVE_USDC, STATA_USDC } from "../src/evm-stata.ts";
import { quoteExactOutputSingle } from "../src/evm-swap.ts";
import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { approveRouter } from "../src/flows/approve-router.ts";
import { approveStata } from "../src/flows/approve-stata.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleDeposit } from "../src/flows/complete-deposit.ts";
import {
  pollRedeemOutcome,
  type RedeemOutcome,
  settleRedeem,
} from "../src/flows/complete-redeem.ts";
import {
  pollSupplyOutcome,
  settleSupply,
  type SupplyOutcome,
} from "../src/flows/complete-supply.ts";
import { pollSwapOutcome, settleSwap, type SwapOutcome } from "../src/flows/complete-swap.ts";
import { settleWithdraw } from "../src/flows/complete-withdraw.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { initialise } from "../src/flows/initialise.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startDeposit } from "../src/flows/start-deposit.ts";
import { startRedeem } from "../src/flows/start-redeem.ts";
import { startSupply } from "../src/flows/start-supply.ts";
import { startSwap } from "../src/flows/start-swap.ts";
import { startWithdraw } from "../src/flows/start-withdraw.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

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

// The Aave underlying deposited (untimed arrange) and then supplied into the
// stataUSDC wrapper, mirroring tests/supply-redeem-e2e.test.ts: 1 USDC. The
// redeem sequence redeems whatever shares the supply mints.
const SUPPLY_AMOUNT = parseUnits("1", 6);

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

// The per-leg wall-clock records the report test prints: one sequence per
// key, each holding the step names of its BenchmarkLeg values, filled by the
// timed legs below as they run. This initialiser is the single definition of
// which sequences the report covers.
const timings: {
  readonly initialise: Record<string, number>;
  readonly approve: Record<string, number>;
  readonly deposit: Record<string, number>;
  readonly withdraw: Record<string, number>;
  readonly swap: Record<string, number>;
  readonly approveStata: Record<string, number>;
  readonly supply: Record<string, number>;
  readonly redeem: Record<string, number>;
  readonly refund: Record<string, number>;
} = {
  initialise: {},
  approve: {},
  deposit: {},
  withdraw: {},
  swap: {},
  approveStata: {},
  supply: {},
  redeem: {},
  refund: {},
};

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
      "time initialise: seal the vault config (skips when an earlier flow already initialised)",
      async () => {
        const context = await session.vaultContext();
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // initialise is one-shot per contract: in a full-suite run happy-day
        // (FILE_ORDER-first) has already consumed it, so its prove is only
        // recorded when this file runs against a fresh deploy.
        if ((await readLedger()).initialised) {
          logSkip("initialise", "vault already initialised (an earlier flow file ran it)");
          return;
        }

        recorder.setLeg(BenchmarkLeg.Initialise);
        const stop = startTimer();
        await initialise(context, {
          vaultEvmAddress: context.evmVaultAddress,
          mpcResponseKey: requireEnv("MPC_RESPONSE_KEY"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.initialise.initialise = ms;
        recorder.recordLeg(BenchmarkLeg.Initialise, ms);

        expect((await readLedger()).initialised, "initialise must set the initialised flag").toBe(
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

        recorder.setLeg(BenchmarkLeg.ApproveRouter);
        const stop = startTimer();
        approveRequestId = await approveRouter(context, evmNonce);
        const ms = stop();
        recorder.clearLeg();
        timings.approve.approveRouter = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveRouter, ms);

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

        recorder.setLeg(BenchmarkLeg.DepositStart);
        const stop = startTimer();
        depositRequestId = await startDeposit(context, { amount: DEPOSIT_AMOUNT, evmNonce });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.startDeposit = ms;
        recorder.recordLeg(BenchmarkLeg.DepositStart, ms);

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
          requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
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

    // Populated by the poll leg below for the settle leg.
    let depositOutcome: RespondOutcome;

    it(
      "time pollRespondBidirectional (deposit): the MPC attests the sweep as succeeded",
      async () => {
        expect(depositRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.DepositPollRespondBidirectional);
        const stop = startTimer();
        depositOutcome = await pollRespondBidirectional(context, {
          requestId: depositRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.pollRespondBidirectional = ms;
        recorder.recordLeg(BenchmarkLeg.DepositPollRespondBidirectional, ms);

        // The settle below can only mint from a success attestation.
        expect(depositOutcome.succeeded, "the MPC must attest the deposit sweep as succeeded").toBe(
          true,
        );
      },
      5 * MINUTE,
    );

    it(
      "time completeDeposit: verify the attestation in-circuit and consume the request",
      async () => {
        expect(depositRequestId).toBeDefined();
        expect(depositOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(depositRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // claimed this request the entry is gone and completeDeposit would
        // reject with "Deposit not found", so skip cleanly instead.
        const before = await readLedger();
        if (!before.depositEventMap.member(requestKey)) {
          logSkip(
            "completeDeposit",
            `request ${depositRequestId} already claimed (not on the ledger)`,
          );
          return;
        }

        // The attestation is already resolved (the poll leg above owns that
        // cost), so this span is the prove-and-submit alone.
        recorder.setLeg(BenchmarkLeg.DepositComplete);
        const stop = startTimer();
        await settleDeposit(context, depositRequestId, depositOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.deposit.completeDeposit = ms;
        recorder.recordLeg(BenchmarkLeg.DepositComplete, ms);

        const after = await readLedger();
        expect(
          after.depositEventMap.member(requestKey),
          "completeDeposit must consume the request from the ledger",
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

        recorder.setLeg(BenchmarkLeg.WithdrawStart);
        const stop = startTimer();
        withdrawRequestId = await startWithdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress,
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.startWithdraw = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawStart, ms);

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

    // Populated by the poll leg below for the settle leg.
    let withdrawOutcome: RespondOutcome;

    it(
      "time pollRespondBidirectional (withdraw): the MPC attests the transfer as succeeded",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.WithdrawPollRespondBidirectional);
        const stop = startTimer();
        withdrawOutcome = await pollRespondBidirectional(context, {
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
          withdrawOutcome.succeeded,
          "the MPC must attest the withdraw transfer as succeeded",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "time completeWithdraw: settle the withdrawal and consume the request + refund marker",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        expect(withdrawOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(withdrawRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this request the pending-withdrawal marker is gone and
        // completeWithdraw would reject with "Withdrawal not found" — skip
        // cleanly instead.
        const before = await readLedger();
        if (!before.withdrawSettleViews.member(requestKey)) {
          logSkip(
            "completeWithdraw",
            `withdrawal ${withdrawRequestId} already settled (no pending marker on the ledger)`,
          );
          return;
        }

        // The attestation is already resolved (the poll leg above owns that
        // cost), so this span is the prove-and-submit alone.
        recorder.setLeg(BenchmarkLeg.WithdrawComplete);
        const stop = startTimer();
        await settleWithdraw(context, withdrawRequestId, withdrawOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.withdraw.completeWithdraw = ms;
        recorder.recordLeg(BenchmarkLeg.WithdrawComplete, ms);

        const after = await readLedger();
        expect(
          after.signBidirectionalEventMap.member(requestKey),
          "completeWithdraw must consume the request from the ledger",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // ── Swap round trip, one timed leg per test ────────────────────────────
    // The setup pipeline verifies the Uniswap router is deployed on the fork
    // before the suite runs, so every leg here executes.

    let swapAmountInMaximum: bigint;
    let swapRequestId: RequestIdHex;

    it(
      "swap arrange: quote the cap and deposit the tokenIn coin the swap will surrender (untimed)",
      async () => {
        if (env.BENCHMARK_SWAP_REQUEST_ID) {
          logSkip("swap arrange", "BENCHMARK_SWAP_REQUEST_ID present, resuming past the arrange");
          return;
        }
        const context = await session.vaultContext();

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
        // Arrange-stage plumbing, deliberately untimed: its
        // startDeposit/completeDeposit proves still land in the recorder as
        // extra warm samples.
        const { requestId } = await runDepositRoundTrip(session, { amount: amountInMaximum });
        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      30 * MINUTE,
    );

    it(
      "time swap: record the swap request on the vault ledger",
      async () => {
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

        recorder.setLeg(BenchmarkLeg.SwapStart);
        const stop = startTimer();
        swapRequestId = await startSwap(context, {
          tokenOut: SWAP_TOKEN_OUT,
          fee: SWAP_FEE,
          amountOut: SWAP_AMOUNT_OUT,
          amountInMaximum: swapAmountInMaximum,
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.swap.startSwap = ms;
        recorder.recordLeg(BenchmarkLeg.SwapStart, ms);

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
        expect(signedSwapTransaction).toBeDefined();
        const context = await session.vaultContext();

        // tolerateRevert: an on-chain revert is a valid outcome the MPC
        // attests as a failure, and the settle would then route to
        // refundSwap, which the settle leg below rejects as an unexpected
        // benchmark outcome.
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

        // The settle below must prove completeSwap, not refundSwap: the swap
        // round trip is the happy path (the swap-refund spec owns the
        // refundSwap benchmark).
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
        expect(swapRequestId).toBeDefined();
        expect(swapOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(swapRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this swap the pending-swap marker is gone — skip cleanly.
        const before = await readLedger();
        if (!before.swapSettleViews.member(requestKey)) {
          logSkip("completeSwap", `swap ${swapRequestId} already settled (no pending marker)`);
          return;
        }

        recorder.setLeg(BenchmarkLeg.SwapComplete);
        const stop = startTimer();
        const settled = await settleSwap(context, swapRequestId, swapOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.swap.completeSwap = ms;
        recorder.recordLeg(BenchmarkLeg.SwapComplete, ms);

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

    // ── Aave sequences, one timed leg per test ─────────────────────────────
    // approveStata (sign-only), then a supply round trip ending in
    // completeSupply, then a redeem of the freshly minted shares ending in
    // completeRedeem, mirroring tests/supply-redeem-e2e.test.ts. The setup
    // pipeline verifies the stataUSDC wrapper is deployed on the fork before
    // the suite runs, so every leg here executes.

    it(
      "aave arrange: deposit the Aave underlying the supply will surrender (untimed)",
      async () => {
        if (env.BENCHMARK_SUPPLY_REQUEST_ID) {
          logSkip("aave arrange", "BENCHMARK_SUPPLY_REQUEST_ID present, resuming past the arrange");
          return;
        }

        // The supplied coin is the AAVE underlying's own vault colour, so the
        // arrange deposits THAT token (the wrapper pulls it from the vault's
        // EVM account during the supply). Setup deals it to the user on the
        // fork, and the deposit flow fails with a pointed sweep error otherwise.
        // Arrange-stage plumbing, deliberately untimed: its
        // startDeposit/completeDeposit proves still land in the recorder as
        // extra warm samples.
        const { requestId } = await runDepositRoundTrip(session, {
          amount: SUPPLY_AMOUNT,
          erc20Address: AAVE_USDC,
        });
        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      30 * MINUTE,
    );

    // Populated by the request leg below for the sign + broadcast legs.
    let approveStataRequestId: RequestIdHex;

    it(
      "time approveStata: record the wrapper-allowance request on the vault ledger",
      async () => {
        const context = await session.vaultContext();
        // The approve tx is sent FROM the vault's derived account. Like
        // approveRouter it is repeatable (a repeat re-sets the same
        // allowance), so it always runs and always records a prove.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.ApproveStata);
        const stop = startTimer();
        approveStataRequestId = await approveStata(context, evmNonce);
        const ms = stop();
        recorder.clearLeg();
        timings.approveStata.approveStata = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveStata, ms);

        expect(approveStataRequestId).toMatch(/^[0-9a-f]{64}$/);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedApproveStataTransaction: Transaction;

    it(
      "time pollSignatureResponse (approveStata): the MPC signs the approve",
      async () => {
        expect(approveStataRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.ApproveStataPollSignatureResponse);
        const stop = startTimer();
        signedApproveStataTransaction = await pollSignatureResponse(context, {
          requestId: approveStataRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        });
        const ms = stop();
        recorder.clearLeg();
        timings.approveStata.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveStataPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (approveStata): the approve mines on the EVM",
      async () => {
        expect(signedApproveStataTransaction).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.ApproveStataBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedApproveStataTransaction });
        const ms = stop();
        recorder.clearLeg();
        timings.approveStata.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.ApproveStataBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    // Populated by the request leg (or BENCHMARK_SUPPLY_REQUEST_ID) for the
    // subsequent supply stages.
    let supplyRequestId: RequestIdHex;

    it(
      "time supply: record the supply request on the vault ledger",
      async () => {
        if (env.BENCHMARK_SUPPLY_REQUEST_ID) {
          supplyRequestId = env.BENCHMARK_SUPPLY_REQUEST_ID as RequestIdHex;
          logSkip(
            "supply",
            `BENCHMARK_SUPPLY_REQUEST_ID present, resuming supply '${supplyRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        // The deposit tx is sent FROM the vault's derived account (it holds
        // the pooled underlying), and the nonce fetch stays outside the timed span.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.SupplyStart);
        const stop = startTimer();
        supplyRequestId = await startSupply(context, { amount: SUPPLY_AMOUNT, evmNonce });
        const ms = stop();
        recorder.clearLeg();
        timings.supply.startSupply = ms;
        recorder.recordLeg(BenchmarkLeg.SupplyStart, ms);

        expect(supplyRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Benchmark supply request recorded on the vault ledger:`,
          "",
          `  request id: ${supplyRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_SUPPLY_REQUEST_ID=${supplyRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedSupplyTransaction: Transaction;

    it(
      "time pollSignatureResponse (supply): the MPC signs the wrapper deposit",
      async () => {
        expect(supplyRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Supplies are signed by the VAULT's derived account, read from the
        // vault's SUPPLY ledger map.
        recorder.setLeg(BenchmarkLeg.SupplyPollSignatureResponse);
        const stop = startTimer();
        signedSupplyTransaction = await pollSignatureResponse(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.supply.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.SupplyPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (supply): the wrapper deposit mines on the EVM",
      async () => {
        expect(signedSupplyTransaction).toBeDefined();
        const context = await session.vaultContext();

        // tolerateRevert: an on-chain revert is a valid outcome the MPC
        // attests as a failure, and the settle would then route to
        // refundSupply, which the settle leg below rejects as an unexpected
        // benchmark outcome.
        recorder.setLeg(BenchmarkLeg.SupplyBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedSupplyTransaction, tolerateRevert: true });
        const ms = stop();
        recorder.clearLeg();
        timings.supply.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.SupplyBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    // Populated by the poll leg below for the settle leg.
    let supplyOutcome: SupplyOutcome;
    // Populated by the settle leg for the redeem request leg's sizing.
    let supplyShares: bigint | undefined;

    it(
      "time pollSupplyOutcome: the MPC attests the shares minted",
      async () => {
        expect(supplyRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.SupplyPollOutcome);
        const stop = startTimer();
        supplyOutcome = await pollSupplyOutcome(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.supply.pollSupplyOutcome = ms;
        recorder.recordLeg(BenchmarkLeg.SupplyPollOutcome, ms);

        // The settle below must prove completeSupply, not refundSupply: the
        // supply round trip is the happy path (the supply-refund spec owns
        // the refundSupply benchmark).
        expect(
          supplyOutcome.matchedFailureOutput,
          "the MPC must attest the supply as executed (shares), not the failure output",
        ).toBe(false);
      },
      5 * MINUTE,
    );

    it(
      "time completeSupply: settle the supply and consume the request + supply marker",
      async () => {
        expect(supplyRequestId).toBeDefined();
        expect(supplyOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(supplyRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this supply the pending-supply marker is gone, so skip cleanly.
        const before = await readLedger();
        if (!before.supplySettleViews.member(requestKey)) {
          logSkip(
            "completeSupply",
            `supply ${supplyRequestId} already settled (no pending marker)`,
          );
          return;
        }

        recorder.setLeg(BenchmarkLeg.SupplyComplete);
        const stop = startTimer();
        const settled = await settleSupply(context, supplyRequestId, supplyOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.supply.completeSupply = ms;
        recorder.recordLeg(BenchmarkLeg.SupplyComplete, ms);

        expect(settled.refunded, "the happy-path supply must settle through completeSupply").toBe(
          false,
        );
        supplyShares = settled.shares;
        const after = await readLedger();
        expect(
          after.supplyEventMap.member(requestKey),
          "completeSupply must consume the request from the supply ledger map",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // Populated by the request leg (or BENCHMARK_REDEEM_REQUEST_ID) for the
    // subsequent redeem stages.
    let redeemRequestId: RequestIdHex;

    it(
      "time redeem: record the redeem request on the vault ledger",
      async () => {
        if (env.BENCHMARK_REDEEM_REQUEST_ID) {
          redeemRequestId = env.BENCHMARK_REDEEM_REQUEST_ID as RequestIdHex;
          logSkip(
            "redeem",
            `BENCHMARK_REDEEM_REQUEST_ID present, resuming redeem '${redeemRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        // The redeemed shares come from the supply settle. When a resumed run
        // skipped that leg, the wallet's stataUSDC vault-coin balance holds
        // the minted shares.
        const shares =
          supplyShares ??
          (await (await session.wallet()).facade.waitForSyncedState()).shielded.balances[
            vaultTokenType(STATA_USDC, context.vaultContractAddress)
          ] ??
          0n;
        expect(shares, "no stataUSDC shares to redeem (run the supply sequence)").toBeGreaterThan(
          0n,
        );
        // The redeem tx is sent FROM the vault's derived account, and the
        // nonce fetch stays outside the timed span.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        recorder.setLeg(BenchmarkLeg.RedeemStart);
        const stop = startTimer();
        redeemRequestId = await startRedeem(context, { shares, evmNonce });
        const ms = stop();
        recorder.clearLeg();
        timings.redeem.startRedeem = ms;
        recorder.recordLeg(BenchmarkLeg.RedeemStart, ms);

        expect(redeemRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Benchmark redeem request recorded on the vault ledger:`,
          "",
          `  request id: ${redeemRequestId}`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  BENCHMARK_REDEEM_REQUEST_ID=${redeemRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll leg below for the broadcast leg.
    let signedRedeemTransaction: Transaction;

    it(
      "time pollSignatureResponse (redeem): the MPC signs the wrapper redeem",
      async () => {
        expect(redeemRequestId).toBeDefined();
        const context = await session.vaultContext();

        // Redeems are signed by the VAULT's derived account, read from the
        // vault's REDEEM ledger map.
        recorder.setLeg(BenchmarkLeg.RedeemPollSignatureResponse);
        const stop = startTimer();
        signedRedeemTransaction = await pollSignatureResponse(context, {
          requestId: redeemRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_REDEEM_REQUESTS_PATH,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.redeem.pollSignatureResponse = ms;
        recorder.recordLeg(BenchmarkLeg.RedeemPollSignatureResponse, ms);
      },
      5 * MINUTE,
    );

    it(
      "time broadcastEvm (redeem): the wrapper redeem mines on the EVM",
      async () => {
        expect(signedRedeemTransaction).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.RedeemBroadcastEvm);
        const stop = startTimer();
        await broadcastEvm(context, { transaction: signedRedeemTransaction, tolerateRevert: true });
        const ms = stop();
        recorder.clearLeg();
        timings.redeem.broadcastEvm = ms;
        recorder.recordLeg(BenchmarkLeg.RedeemBroadcastEvm, ms);
      },
      3 * MINUTE,
    );

    // Populated by the poll leg below for the settle leg.
    let redeemOutcome: RedeemOutcome;

    it(
      "time pollRedeemOutcome: the MPC attests the assets minted",
      async () => {
        expect(redeemRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.RedeemPollOutcome);
        const stop = startTimer();
        redeemOutcome = await pollRedeemOutcome(context, {
          requestId: redeemRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.redeem.pollRedeemOutcome = ms;
        recorder.recordLeg(BenchmarkLeg.RedeemPollOutcome, ms);

        expect(
          redeemOutcome.matchedFailureOutput,
          "the MPC must attest the redeem as executed (assets), not the failure output",
        ).toBe(false);
      },
      5 * MINUTE,
    );

    it(
      "time completeRedeem: settle the redeem and consume the request + redeem marker",
      async () => {
        expect(redeemRequestId).toBeDefined();
        expect(redeemOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(redeemRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this redeem the pending-redeem marker is gone, so skip cleanly.
        const before = await readLedger();
        if (!before.redeemSettleViews.member(requestKey)) {
          logSkip(
            "completeRedeem",
            `redeem ${redeemRequestId} already settled (no pending marker)`,
          );
          return;
        }

        recorder.setLeg(BenchmarkLeg.RedeemComplete);
        const stop = startTimer();
        const settled = await settleRedeem(context, redeemRequestId, redeemOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.redeem.completeRedeem = ms;
        recorder.recordLeg(BenchmarkLeg.RedeemComplete, ms);

        expect(settled.refunded, "the happy-path redeem must settle through completeRedeem").toBe(
          false,
        );
        const after = await readLedger();
        expect(
          after.redeemEventMap.member(requestKey),
          "completeRedeem must consume the request from the redeem ledger map",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // ── Refund sequence, one timed leg per test ────────────────────────────
    // The deposit-withdrawal-failure recipe (see
    // tests/deposit-withdrawal-failure-refund.test.ts): drain the vault's
    // EVM ERC20 balance so the withdraw transfer mines and REVERTS, the MPC
    // attests the fixed 5-byte failure output, and the settle proves
    // refundWithdraw. Works on any stack (no Uniswap needed), and the drain
    // is fakenet-only, like the source recipe.

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

        recorder.setLeg(BenchmarkLeg.RefundStartWithdraw);
        const stop = startTimer();
        refundWithdrawRequestId = await startWithdraw(context, {
          amount: REFUND_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
          evmNonce,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.startWithdraw = ms;
        recorder.recordLeg(BenchmarkLeg.RefundStartWithdraw, ms);

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

    // Populated by the poll leg below for the settle leg.
    let refundOutcome: RespondOutcome;

    it(
      "time pollRespondBidirectional (refund): the MPC attests the transfer as FAILED",
      async () => {
        expect(refundWithdrawRequestId).toBeDefined();
        const context = await session.vaultContext();

        recorder.setLeg(BenchmarkLeg.RefundPollRespondBidirectional);
        const stop = startTimer();
        refundOutcome = await pollRespondBidirectional(context, {
          requestId: refundWithdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });
        const ms = stop();
        recorder.clearLeg();
        timings.refund.pollRespondBidirectional = ms;
        recorder.recordLeg(BenchmarkLeg.RefundPollRespondBidirectional, ms);

        // Only the fixed failure output routes the settle to refundWithdraw,
        // the whole point of this sequence.
        expect(
          refundOutcome.matchedFailureOutput,
          "a mined revert must be attested as the fixed MPC failure output",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "time refundWithdraw: settle the doomed withdrawal",
      async () => {
        expect(refundWithdrawRequestId).toBeDefined();
        expect(refundOutcome).toBeDefined();
        const context = await session.vaultContext();
        const requestKey = requestIdBytes(refundWithdrawRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already
        // settled this request the pending-withdrawal marker is gone — skip
        // cleanly instead.
        const before = await readLedger();
        if (!before.withdrawSettleViews.member(requestKey)) {
          logSkip(
            "refundWithdraw",
            `withdrawal ${refundWithdrawRequestId} already settled (no pending marker on the ledger)`,
          );
          return;
        }

        // The settle flow routes the failure output to refundWithdraw (see
        // src/flows/complete-withdraw.ts), the prove this leg exists to
        // record. The attestation is already resolved (the poll leg above
        // owns that cost), so this span is the prove-and-submit alone.
        recorder.setLeg(BenchmarkLeg.RefundWithdraw);
        const stop = startTimer();
        await settleWithdraw(context, refundWithdrawRequestId, refundOutcome);
        const ms = stop();
        recorder.clearLeg();
        timings.refund.refundWithdraw = ms;
        recorder.recordLeg(BenchmarkLeg.RefundWithdraw, ms);

        const after = await readLedger();
        expect(
          after.withdrawSettleViews.member(requestKey),
          "refundWithdraw must consume the pending-withdrawal marker",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    it(
      "report: per-leg wall clock of every sequence",
      () => {
        // The banner sections come from `timings` itself, so every sequence
        // the initialiser declares is reported. Legs a resumed, rerun or
        // skipped pass never ran are simply absent: the report never
        // fabricates a number for work this run did not do.
        const section = (label: string, record: Record<string, number>): string[] => {
          const rows = Object.entries(record).map(
            ([leg, ms]) => `  ${`${label}.${leg}`.padEnd(44)}${String(ms).padStart(9)} ms`,
          );
          return rows.length > 0
            ? rows
            : [`  ${label}: (every leg skipped: resumed, rerun, or unavailable)`];
        };

        banner([
          "Benchmark report, per-leg wall clock:",
          "",
          ...Object.entries(timings).flatMap(([sequence, record]) => section(sequence, record)),
        ]);

        // The machine-readable twin of the banner, one line per run, for
        // scraping baselines out of run logs.
        console.log(`BENCHMARK_TIMINGS_JSON ${JSON.stringify(timings)}`);

        // Every reported number is a real measurement: a leg that did not run
        // is absent from its sequence, never present as a NaN or a negative
        // span from a stopwatch that was never started.
        const measurements = Object.values(timings).flatMap((record) => Object.values(record));
        expect(measurements.filter((ms) => !Number.isFinite(ms) || ms < 0)).toEqual([]);
      },
      MINUTE,
    );
  },
);
