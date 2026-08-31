// The failure-refund e2e flow: a withdraw whose EVM transfer FAILS must end
// with the MPC attesting failure and completeWithdraw taking the REFUND
// branch in-circuit — the escrowed shielded vault tokens re-minted to the
// caller, the request + its pending-withdrawal marker consumed.
//
// Failure-injection strategy (deliberate, deterministic): make the withdraw
// transfer MINE and REVERT by draining the vault's EVM ERC20 balance first.
// The responder (fakenet compose service) attests an EVM outcome only from a
// mined receipt (success or revert) or a consumed nonce — it never times out
// a forever-pending tx — and a mined `status 0` receipt is exactly what its
// failure attestation (the 0xdeadbeef error sentinel) is for. The drain
// signs with the vault account's fakenet-derived key (test-support only, see
// src/fakenet-vault-account.ts) and sends the balance back to
// EVM_USER_ADDRESS, so the suite's EVM funds keep cycling. Amounts are
// computed from live balances, never assumed.
//
// The arrange stage runs a full deposit round trip first (the caller must
// hold shielded vault tokens to escrow) — that is what
// src/flows/deposit.ts's runDepositRoundTrip exists for. Run AFTER
// tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there. Recovery
// from a run that died mid-flow (proof-server OOM): rerun this file with
// FAILURE_REFUND_DEPOSIT_REQUEST_ID / FAILURE_REFUND_WITHDRAW_REQUEST_ID set
// to the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.

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

import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { completeWithdraw } from "../src/flows/complete-withdraw.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startWithdraw } from "../src/flows/withdraw.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";

// ethers types `hash` nullable for the unsigned case; a transaction that came
// back from the MPC is signed, so a null here is a broken response, not a
// formatting concern.
const signedTxHash = (transaction: Transaction): string => {
  if (transaction.hash === null) {
    throw new Error("expected a signed transaction to carry a hash");
  }
  return transaction.hash;
};

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

// Wallet facade + vault context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createVaultSession(env);

// One deposit's worth of shielded vault tokens is arranged, escrowed by the
// doomed withdraw, and refunded — 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault deposit → withdraw-failure → refund e2e",
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
        expect(
          balance,
          `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`,
        ).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT);

        // The vault's derived account sends the doomed transfer itself (and the
        // drain before it): require the fee-cap budget of one MPC-signed ERC20
        // transfer, like the happy-day withdraw leg. Actual spend sits far
        // below the cap — a reverted transfer burns ~35k gas and the drain
        // rides the same margin.
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
      "vault-initialised preflight: the vault contract is initialised (read-only)",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(
          state.initialised,
          "vault is not initialised: run tests/happy-day-e2e.test.ts first (or initialise the vault)",
        ).toBe(1n);
      },
      5 * MINUTE,
    );

    it(
      "arrange: deposit round trip mints the shielded vault tokens the doomed withdraw will escrow",
      async () => {
        const { requestId } = await runDepositRoundTrip(session, {
          amount: DEPOSIT_AMOUNT,
          reuseRequestId: env.FAILURE_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete — the caller holds ${String(DEPOSIT_AMOUNT)} base units of shielded vault tokens.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  FAILURE_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      15 * MINUTE,
    );

    it(
      "arrange: drain the vault's EVM ERC20 balance (fakenet-only) so the withdraw transfer must revert",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const erc20Address = requireEnv("ERC20_ADDRESS");

        // Send the vault's FULL live balance (the arrange sweep plus any
        // prior-run leftovers) back to the user's derived account. A zero
        // balance means a prior aborted run already drained it.
        const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"));
        if (drained === 0n) {
          logSkip("drain", "the vault's derived account already holds no ERC20");
        }

        const { balance } = await getErc20Balance(rpcUrl, erc20Address, vaultAddress);
        expect(
          balance,
          `the vault ${vaultAddress} must hold NO ERC20 so the ${String(WITHDRAW_AMOUNT)}-unit transfer reverts`,
        ).toBe(0n);
      },
      3 * MINUTE,
    );

    // Populated by the request leg (or FAILURE_REFUND_WITHDRAW_REQUEST_ID) for
    // the subsequent stages.
    let withdrawRequestId: RequestIdHex;

    it(
      "withdraw: escrow shielded vault tokens for a transfer the vault cannot pay",
      async () => {
        if (env.FAILURE_REFUND_WITHDRAW_REQUEST_ID) {
          withdrawRequestId = env.FAILURE_REFUND_WITHDRAW_REQUEST_ID as RequestIdHex;
          logSkip(
            "withdraw",
            `FAILURE_REFUND_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();

        // Nonce fetched AFTER the drain mined (the drain consumed one), so the
        // signed transfer is the vault account's next expected tx.
        const evmNonce = await getTransactionNonce(
          requireEnv("EVM_RPC_URL"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );

        withdrawRequestId = await startWithdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
          evmNonce,
        });
        expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Doomed withdraw request recorded on the vault ledger:`,
          "",
          `  request id: ${withdrawRequestId}`,
          "",
          "The caller's shielded vault tokens are escrowed. If a later step dies,",
          `resume with FAILURE_REFUND_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedWithdrawTransaction: Transaction;

    it(
      "pollSignatureResponse: the MPC signs the doomed transfer",
      async () => {
        expect(withdrawRequestId).toBeDefined();

        const context = await session.vaultContext();
        // Withdraw transfers are signed by the VAULT's derived account.
        signedWithdrawTransaction = await pollSignatureResponse(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 2 * MINUTE,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        });

        banner([
          `MPC signed response for doomed withdraw ${withdrawRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedWithdrawTransaction)}`,
        ]);
      },
      5 * MINUTE,
    );

    it(
      "broadcast the doomed transfer: it mines and REVERTS, so broadcastEvm throws",
      async () => {
        expect(signedWithdrawTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm cannot return normally here: the transfer exceeds the
        // vault's (zero) ERC20 balance, so it mines with `status 0` and
        // broadcastEvm surfaces that as its reverted-on-chain error — also on
        // reruns, where the already-mined reverted receipt short-circuits to
        // the same throw. The mined receipt is what the responder attests from.
        await expect(
          broadcastEvm(context, { transaction: signedWithdrawTransaction }),
        ).rejects.toThrow(/reverted on-chain/);

        banner([
          `Doomed transfer ${signedTxHash(signedWithdrawTransaction)} mined and reverted, as arranged.`,
          "",
          "The responder should observe the status-0 receipt and post its",
          "failure attestation (the digest of the fixed 5-byte 0xdeadbeef01",
          "failure output) on its next poll.",
        ]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let withdrawAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests the transfer as FAILED",
      async () => {
        expect(withdrawRequestId).toBeDefined();

        // The event carries only the digest, so the poll fetches the observed
        // result from the fakenet's /responses API and matches: for a mined
        // revert the API serves success: false, so the ONLY matchable
        // candidate is the protocol's fixed failure output.
        const context = await session.vaultContext();
        withdrawAttestation = await pollRespondBidirectional(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
        });

        // The observable contract of the failure leg: the attested output must
        // be the MPC's failure output (0xdeadbeef sentinel), never a success.
        expect(
          withdrawAttestation.succeeded,
          "the MPC must attest the reverted transfer as failed",
        ).toBe(false);
        expect(
          withdrawAttestation.matchedFailureOutput,
          "a mined revert must be attested as the fixed MPC failure output",
        ).toBe(true);

        banner([
          `Found failure attestation for doomed withdraw ${withdrawRequestId}:`,
          "",
          `  succeeded:           false`,
          `  MPC failure output:  true (signature-verified)`,
        ]);
      },
      5 * MINUTE,
    );

    it(
      "completeWithdraw: routes to refund and consumes the request + refund marker",
      async () => {
        // Final leg: the request is on the vault ledger and the MPC's FAILURE
        // attestation is posted (previous steps). The settle flow routes the
        // fixed 5-byte failure output to refundWithdraw, which
        // re-verifies the attestation in-circuit (digest equality + ECDSA
        // against the stored MPC response key), checks the sentinel bytes, and
        // re-mints the surrendered shielded value to the withdrawer (this
        // session's wallet, which proves the pinned refund commitment) instead
        // of leaving it burned. The request + its pending-withdrawal marker
        // are consumed (double-settle protection). The refunded shielded
        // balance itself is not publicly observable; the marker consumption is
        // (present before, absent after), and refund is the only
        // circuit a failure attestation can settle through.
        expect(withdrawRequestId).toBeDefined();
        expect(withdrawAttestation).toBeDefined();

        const context = await session.vaultContext();
        const requestKey = requestIdBytes(withdrawRequestId);
        const readLedger = () =>
          readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

        // Rerun against a kept contract address: if a prior run already settled
        // this request the pending-withdrawal marker is gone and
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
        expect(before.signBidirectionalEventMap.member(requestKey)).toBe(true);

        await completeWithdraw(context, { requestId: withdrawRequestId });

        const after = await readLedger();
        expect(
          after.signBidirectionalEventMap.member(requestKey),
          "refund must consume the request from the ledger",
        ).toBe(false);
        expect(
          after.withdrawSettleViews.member(requestKey),
          "refund must consume the pending-withdrawal marker",
        ).toBe(false);

        banner([
          `Withdraw ${withdrawRequestId} settled with a REFUND.`,
          "",
          "The vault verified the MPC's failure attestation in-circuit,",
          "re-minted the escrowed shielded value to the withdrawer,",
          "and removed the request and its refund marker from the ledger.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
