// The redeem refund e2e flow: a redeem whose wrapper redeem REVERTS must end
// with the MPC attesting it as failed over an empty output, and
// `completeRedeem`'s failure branch re-minting the burned shielded shares to the
// caller and consuming the request. The redeem twin of supply-refund-e2e.
//
// Failure-injection strategy (deliberate, deterministic): the wrapper's redeem
// burns the shares from the vault account, so draining the vault's EVM
// stataToken balance first makes the redeem MINE and REVERT. The drain signs
// with the vault account's fakenet-derived key (test-support only, see
// src/fakenet-vault-account.ts), puts the vault account's nonce back, and sends
// the balance back to EVM_USER_ADDRESS, so the suite's EVM funds keep cycling.
//
// The arrange stages run a deposit round trip of the underlying, then a supply
// round trip of it, so the caller holds the shielded shares the doomed redeem
// burns. Run AFTER tests/happy-day-e2e.test.ts (initialise) and
// tests/approve-e2e.test.ts (the wrapper's allowance on the underlying, which the
// supply needs), as FILE_ORDER pins. Recovery from a run that died mid-flow
// (proof-server OOM): rerun this file with REDEEM_REFUND_DEPOSIT_REQUEST_ID /
// REDEEM_REFUND_SUPPLY_REQUEST_ID / REDEEM_REFUND_REDEEM_REQUEST_ID set to the
// ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { bytesToHex, OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_REDEEM_REQUESTS_PATH,
  vaultGasEnvelope,
  type VaultGasKind,
  type VaultLedgerState,
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
import { formatEther, formatUnits, parseEther, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleRedeem } from "../src/flows/complete-redeem.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startRedeem } from "../src/flows/start-redeem.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import type { VaultContext } from "../src/vault-context.ts";
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

// Wallet facade + vault context shared by every test in this file (lazily
// built, so the offline path never touches the network), stopped once in
// afterAll.
const session = createVaultSession(env);

// 1 USDC (6 decimals): deposited, then supplied for the shares the doomed
// redeem burns and the refund re-mints whole.
const SUPPLY_AMOUNT = 1_000_000n;

/**
 * The vault ledger as the stages read it: the pinned Aave pair lives there,
 * so the spec follows whatever pair the deployment sealed in.
 *
 * @param context - The flow context.
 * @returns The decoded vault ledger state.
 */
const vaultLedger = (context: VaultContext): Promise<VaultLedgerState> =>
  readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault redeem refund e2e: a reverted wrapper redeem re-mints the shares",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: user EVM account holds the supplied underlying, vault EVM account holds the supply and redeem gas budget",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const context = await session.vaultContext();
        const state = await vaultLedger(context);
        const underlying = `0x${bytesToHex(state.stataUnderlying)}`;

        // The user's derived account pays the deposit sweep's gas and supplies
        // the deposited underlying. A resumed deposit already swept it.
        const userEth = await getEthBalance(rpcUrl, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
        );
        expect(userEth, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.01"),
        );
        const required = env.REDEEM_REFUND_DEPOSIT_REQUEST_ID === undefined ? SUPPLY_AMOUNT : 0n;
        const { balance, decimals } = await getErc20Balance(rpcUrl, underlying, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(balance, required, decimals, underlying)} (supplied amount)`,
        );
        expect(
          balance,
          `fund ${userAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${underlying} on EVM`,
        ).toBeGreaterThanOrEqual(required);

        // The vault's derived account sends the supply and the doomed redeem
        // itself (and the drain between them): require the fee-cap budget the
        // vault's gas settings stamp on both. Actual spend sits far below the
        // caps: a reverted redeem burns a fraction of its limit and the drain
        // rides the margin.
        const cost = (kind: VaultGasKind): bigint => {
          const { gasLimit, maxFeePerGas } = vaultGasEnvelope(state, kind);
          return gasLimit * maxFeePerGas;
        };
        const gasBudget = cost("supply") + cost("redeem");
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
        expect(
          (await vaultLedger(context)).initialised,
          "vault is not initialised: run tests/happy-day-e2e.test.ts first (or initialise the vault)",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "arrange: deposit round trip mints the shielded underlying the supply will burn",
      async () => {
        const context = await session.vaultContext();
        const { requestId } = await runDepositRoundTrip(session, {
          amount: SUPPLY_AMOUNT,
          erc20Address: `0x${bytesToHex((await vaultLedger(context)).stataUnderlying)}`,
          reuseRequestId: env.REDEEM_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete: the caller holds ${String(SUPPLY_AMOUNT)} base units of shielded underlying.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  REDEEM_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    // The attested shares the arrange supply minted: the doomed redeem burns
    // them and the refund re-mints them.
    let shares: bigint;

    it(
      "arrange: supply round trip mints the shielded shares the doomed redeem will burn",
      async () => {
        const supplied = await runSupplyRoundTrip(session, {
          amount: SUPPLY_AMOUNT,
          reuseRequestId: env.REDEEM_REFUND_SUPPLY_REQUEST_ID as RequestIdHex | undefined,
        });
        shares = supplied.shares;

        banner([
          `Arrange supply ${supplied.requestId} complete: the caller holds ${String(shares)} shielded shares.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  REDEEM_REFUND_SUPPLY_REQUEST_ID=${supplied.requestId}`,
        ]);

        expect(shares).toBeGreaterThan(0n);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "arrange: drain the vault's EVM stataToken balance (fakenet-only) so the wrapper redeem must revert",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const context = await session.vaultContext();
        const wrapper = `0x${bytesToHex((await vaultLedger(context)).stataToken)}`;

        // Send the vault's FULL live share balance (the arrange supply plus any
        // prior-run leftovers) back to the user's derived account. A zero
        // balance means a prior aborted run already drained it.
        const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"), wrapper);
        if (drained === 0n) {
          logSkip(
            "drain",
            "the vault's derived account already holds none of the wrapper's shares",
          );
        }

        const { balance } = await getErc20Balance(rpcUrl, wrapper, vaultAddress);
        expect(
          balance,
          `the vault ${vaultAddress} must hold NONE of ${wrapper} so the redeem reverts`,
        ).toBe(0n);
      },
      3 * MINUTE,
    );

    // Populated by the start stage (or REDEEM_REFUND_REDEEM_REQUEST_ID) for the
    // later stages.
    let redeemRequestId: RequestIdHex;

    it(
      "redeem: burn the shielded shares for a redeem the vault cannot fund",
      async () => {
        if (env.REDEEM_REFUND_REDEEM_REQUEST_ID) {
          redeemRequestId = env.REDEEM_REFUND_REDEEM_REQUEST_ID as RequestIdHex;
          logSkip(
            "redeem",
            `REDEEM_REFUND_REDEEM_REQUEST_ID present, resuming redeem '${redeemRequestId}'`,
          );
          return;
        }
        expect(shares).toBeDefined();

        const context = await session.vaultContext();

        // The drain put the vault account's nonce back, so the nonce the flush
        // assigns is the account's next expected tx.
        redeemRequestId = await startRedeem(context, { shares });
        expect(redeemRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          "Doomed redeem request recorded on the vault ledger:",
          "",
          `  request id: ${redeemRequestId}`,
          "",
          "The caller's shielded shares are burned. If a later step dies,",
          `resume with REDEEM_REFUND_REDEEM_REQUEST_ID=${redeemRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedRedeemTransaction: Transaction;

    it(
      "pollSignatureResponse: the MPC signs the doomed wrapper redeem",
      async () => {
        expect(redeemRequestId).toBeDefined();

        const context = await session.vaultContext();
        signedRedeemTransaction = await pollSignatureResponse(context, {
          requestId: redeemRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_REDEEM_REQUESTS_PATH,
        });

        banner([
          `MPC signed response for doomed redeem ${redeemRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedRedeemTransaction)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast the doomed redeem: it mines and REVERTS, so broadcastEvm throws",
      async () => {
        expect(signedRedeemTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm cannot return normally here: the wrapper's redeem burns
        // more shares than the vault's (zero) balance holds, so the redeem mines
        // with `status 0` and broadcastEvm surfaces that as its
        // reverted-on-chain error, also on reruns, where the already-mined
        // reverted receipt short-circuits to the same throw. The mined receipt
        // is what the responder attests from.
        await expect(
          broadcastEvm(context, { transaction: signedRedeemTransaction }),
        ).rejects.toThrow(/reverted on-chain/);

        banner([
          `Doomed redeem ${signedTxHash(signedRedeemTransaction)} mined and reverted, as arranged.`,
          "",
          "The responder should observe the status-0 receipt and post its",
          "failed attestation (an empty output under OutputKind.failed) on",
          "its next poll.",
        ]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let redeemAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests the redeem as FAILED",
      async () => {
        expect(redeemRequestId).toBeDefined();

        // A post declaring a failure is checked over the empty output the
        // protocol attests: no trace is needed to match it.
        const context = await session.vaultContext();
        redeemAttestation = await pollRespondBidirectional(context, {
          requestId: redeemRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_REDEEM_REQUESTS_PATH,
        });

        expect(
          redeemAttestation.event.outputKind,
          "a mined revert must be attested under OutputKind.failed",
        ).toBe(OutputKind.failed);
        expect(redeemAttestation.serializedOutput, "a failure's output is empty").toHaveLength(0);

        banner([
          `Found failure attestation for doomed redeem ${redeemRequestId}:`,
          "",
          `  output kind:  ${OutputKind[redeemAttestation.event.outputKind]} (signature-verified)`,
          `  block height: ${String(redeemAttestation.event.blockHeight)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeRedeem: the failure attestation re-mints the burned shares and consumes the request",
      async () => {
        // Settling queues the failure at width 0, flushes it, and
        // completeRedeem takes its failure branch: the wrapper burned nothing,
        // so it re-mints the surrendered shares to the redeemer (this session's
        // wallet, which proves the pinned ownership commitment).
        expect(redeemRequestId).toBeDefined();
        expect(redeemAttestation).toBeDefined();

        const context = await session.vaultContext();
        const state = await vaultLedger(context);
        const isRequestOnLedger = async () =>
          (await vaultLedger(context)).bidirectionalRedeemMap.member(
            requestIdBytes(redeemRequestId),
          );

        // Rerun against a kept contract address: if a prior run already settled
        // this request the entry is gone and completeRedeem would reject with
        // "Request not sent", so skip cleanly instead.
        if (!(await isRequestOnLedger())) {
          logSkip(
            "completeRedeem",
            `redeem ${redeemRequestId} already settled (not on the ledger)`,
          );
          return;
        }

        // The surrendered shares, as the redeem's args hold them: a resumed
        // request's shares need not be this run's arrange supply's.
        const { entry } = state.outputRequestBuffer.lookup(
          state.evictionMap.lookup(requestIdBytes(redeemRequestId)),
        );
        const surrendered = state.redeemArgsMap.lookup(entry.inIndex).request.shares;

        const color = vaultTokenType(
          `0x${bytesToHex(state.stataToken)}`,
          context.vaultContractAddress,
        );
        const wallet = await session.wallet();
        const balanceBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        await settleRedeem(context, redeemAttestation);

        expect(
          await isRequestOnLedger(),
          "completeRedeem must consume the request from the ledger",
        ).toBe(false);
        // The re-mint is a coin addressed to this wallet, so its balance shows it.
        const reminted = await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) >= balanceBefore + surrendered,
        );
        expect(reminted.shielded.balances[color] ?? 0n).toBe(balanceBefore + surrendered);

        banner([
          `Redeem ${redeemRequestId} settled with a RE-MINT of ${String(surrendered)} shares.`,
          "",
          "The vault verified the MPC's failure attestation, re-minted the",
          "burned shielded shares to the redeemer, and removed the request",
          "from its ledger.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
