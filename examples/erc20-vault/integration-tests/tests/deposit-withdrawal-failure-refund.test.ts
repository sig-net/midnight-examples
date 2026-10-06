// The failure-refund e2e flow: a withdraw whose EVM transfer FAILS must end with
// the MPC attesting it as failed over an empty output, and `completeWithdraw`'s
// failure branch re-minting the burned shielded vault tokens to the caller and
// consuming the request.
//
// Failure-injection strategy (deliberate, deterministic): make the withdraw
// transfer MINE and REVERT by draining the vault's EVM ERC20 balance first. The
// responder (fakenet compose service) attests an EVM outcome only from a mined
// receipt (success or revert) or a consumed nonce. It never times out a
// forever-pending tx, and a mined `status 0` receipt is exactly what its `failed`
// attestation is for. The drain signs with the vault account's fakenet-derived
// key (test-support only, see src/fakenet-vault-account.ts), puts the vault
// account's nonce back, and sends the balance back to EVM_USER_ADDRESS, so the
// suite's EVM funds keep cycling. Amounts are computed from live balances, never
// assumed.
//
// The arrange stage runs a full deposit round trip first (the caller must hold
// shielded vault tokens to surrender): that is what
// src/flows/deposit-round-trip.ts's runDepositRoundTrip exists for. Run AFTER
// tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there. Recovery
// from a run that died mid-flow (proof-server OOM): rerun this file with
// FAILURE_REFUND_DEPOSIT_REQUEST_ID / FAILURE_REFUND_WITHDRAW_REQUEST_ID set to
// the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_WITHDRAW_REQUESTS_PATH,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  logSkip,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleWithdraw } from "../src/flows/complete-withdraw.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startWithdraw } from "../src/flows/start-withdraw.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

// ethers types `hash` nullable for the unsigned case. A transaction that came
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
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset: the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + vault context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network),
// stopped once in afterAll.
const session = createVaultSession(env);

// One deposit's worth of shielded vault tokens is arranged, burned by the doomed
// withdraw, and re-minted: 0.1 USDC, the funding preflight's minimum.
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
        console.log(
          `${userAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
        );
        expect(userEth, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.01"),
        );
        const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(balance, parseUnits("0.1", decimals), decimals, erc20Address)}`,
        );
        expect(
          balance,
          `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`,
        ).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT);

        // The vault's derived account sends the doomed transfer itself (and the
        // drain before it): require the fee-cap budget the vault's gas settings
        // stamp on a withdrawal, like the happy-day withdraw leg. Actual spend
        // sits far below the cap: a reverted transfer burns ~35k gas and the
        // drain rides the same margin.
        const context = await session.vaultContext();
        const { gasLimit, maxFeePerGas } = vaultGasEnvelope(
          await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
          "withdraw",
        );
        const gasBudget = gasLimit * maxFeePerGas;
        const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
        console.log(
          `${vaultAddress}: ${fundingSummary(vaultEth, gasBudget, 18, "ETH")} (maximum gas fee)`,
        );
        expect(
          vaultEth,
          `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
        ).toBeGreaterThanOrEqual(gasBudget);
      },
      5 * MINUTE,
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
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "arrange: deposit round trip mints the shielded vault tokens the doomed withdraw will burn",
      async () => {
        const { requestId } = await runDepositRoundTrip(session, {
          amount: DEPOSIT_AMOUNT,
          reuseRequestId: env.FAILURE_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete: the caller holds ${String(DEPOSIT_AMOUNT)} base units of shielded vault tokens.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  FAILURE_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
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
      "withdraw: burn shielded vault tokens for a transfer the vault cannot pay",
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

        // The drain put the vault account's nonce back, so the nonce the flush
        // assigns is the account's next expected tx.
        withdrawRequestId = await startWithdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
        });
        expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Doomed withdraw request recorded on the vault ledger:`,
          "",
          `  request id: ${withdrawRequestId}`,
          "",
          "The caller's shielded vault tokens are burned. If a later step dies,",
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
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });

        banner([
          `MPC signed response for doomed withdraw ${withdrawRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedWithdrawTransaction)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast the doomed transfer: it mines and REVERTS, so broadcastEvm throws",
      async () => {
        expect(signedWithdrawTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm cannot return normally here: the transfer exceeds the
        // vault's (zero) ERC20 balance, so it mines with `status 0` and
        // broadcastEvm surfaces that as its reverted-on-chain error, also on
        // reruns, where the already-mined reverted receipt short-circuits to the
        // same throw. The mined receipt is what the responder attests from.
        await expect(
          broadcastEvm(context, { transaction: signedWithdrawTransaction }),
        ).rejects.toThrow(/reverted on-chain/);

        banner([
          `Doomed transfer ${signedTxHash(signedWithdrawTransaction)} mined and reverted, as arranged.`,
          "",
          "The responder should observe the status-0 receipt and post its",
          "failed attestation (an empty output under OutputKind.failed) on",
          "its next poll.",
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

        // The event carries the MPC's verdict beside the signature, and a post
        // declaring a failure is checked over the empty output the protocol
        // attests: no trace is needed to match it.
        const context = await session.vaultContext();
        withdrawAttestation = await pollRespondBidirectional(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });

        // The observable contract of the failure leg: the verified kind must be
        // `failed` over an empty output, never an execution.
        expect(
          withdrawAttestation.succeeded,
          "the MPC must attest the reverted transfer as failed",
        ).toBe(false);
        expect(
          withdrawAttestation.event.outputKind,
          "a mined revert must be attested under OutputKind.failed",
        ).toBe(OutputKind.failed);
        expect(withdrawAttestation.serializedOutput, "a failure's output is empty").toHaveLength(0);

        banner([
          `Found failure attestation for doomed withdraw ${withdrawRequestId}:`,
          "",
          `  succeeded:    false`,
          `  output kind:  ${OutputKind[withdrawAttestation.event.outputKind]} (signature-verified)`,
          `  block height: ${String(withdrawAttestation.event.blockHeight)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeWithdraw: the failure attestation re-mints the burned tokens and consumes the request",
      async () => {
        // Final leg: the request is on the vault ledger and the MPC's FAILURE
        // attestation is posted (previous steps). Settling queues it at width 0,
        // flushes it, and completeWithdraw takes its failure branch: the
        // transfer moved nothing, so it re-mints the surrendered shielded value
        // to the withdrawer (this session's wallet, which proves the pinned
        // ownership commitment) and consumes the request (double-settle
        // protection).
        expect(withdrawRequestId).toBeDefined();
        expect(withdrawAttestation).toBeDefined();

        const context = await session.vaultContext();
        const requestIndex = requestIdBytes(withdrawRequestId);
        const isRequestOnLedger = async () =>
          (
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            )
          ).bidirectionalWithdrawMap.member(requestIndex);

        // Rerun against a kept contract address: if a prior run already settled
        // this request the entry is gone and completeWithdraw would reject with
        // "Request not sent", so skip cleanly instead.
        if (!(await isRequestOnLedger())) {
          logSkip(
            "completeWithdraw",
            `withdrawal ${withdrawRequestId} already settled (not on the ledger)`,
          );
          return;
        }

        const color = vaultTokenType(
          requireEnv("ERC20_ADDRESS"),
          requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
        );
        const wallet = await session.wallet();
        const balanceBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        await settleWithdraw(context, withdrawAttestation);

        expect(
          await isRequestOnLedger(),
          "completeWithdraw must consume the request from the ledger",
        ).toBe(false);
        // The re-mint is a coin addressed to this wallet, so its balance shows it.
        const reminted = await waitForFacadeState(
          wallet.facade,
          (state) => (state.shielded.balances[color] ?? 0n) >= balanceBefore + WITHDRAW_AMOUNT,
        );
        expect(reminted.shielded.balances[color] ?? 0n).toBe(balanceBefore + WITHDRAW_AMOUNT);

        banner([
          `Withdraw ${withdrawRequestId} settled with a RE-MINT.`,
          "",
          "The vault verified the MPC's failure attestation, re-minted the",
          "burned shielded value to the withdrawer, and removed the request",
          "from its ledger.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
