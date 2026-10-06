// The supply refund e2e flow: a supply whose wrapper deposit REVERTS must end
// with the MPC attesting it as failed over an empty output, and
// `completeSupply`'s failure branch re-minting the burned shielded underlying to
// the caller and consuming the request. The lending twin of
// deposit-withdrawal-failure-refund.
//
// Failure-injection strategy (deliberate, deterministic): the wrapper's deposit
// pulls the underlying from the vault account with transferFrom, so draining the
// vault's EVM underlying balance first makes the deposit MINE and REVERT. The
// wrapper's allowance (tests/approve-e2e.test.ts) stays in place, so the revert
// is purely the zero balance. The drain signs with the vault account's
// fakenet-derived key (test-support only, see src/fakenet-vault-account.ts),
// puts the vault account's nonce back, and sends the balance back to
// EVM_USER_ADDRESS, so the suite's EVM funds keep cycling.
//
// The arrange stage runs a deposit round trip of the underlying first (the
// caller must hold shielded underlying to surrender). Run AFTER
// tests/happy-day-e2e.test.ts (initialise) and tests/approve-e2e.test.ts, as
// FILE_ORDER pins. Recovery from a run that died mid-flow (proof-server OOM):
// rerun this file with SUPPLY_REFUND_DEPOSIT_REQUEST_ID /
// SUPPLY_REFUND_SUPPLY_REQUEST_ID set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { bytesToHex, OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_SUPPLY_REQUESTS_PATH,
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
import { formatEther, formatUnits, parseEther, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleSupply } from "../src/flows/complete-supply.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startSupply } from "../src/flows/start-supply.ts";
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

// 1 USDC (6 decimals): deposited, burned by the doomed supply, and re-minted whole.
const SUPPLY_AMOUNT = 1_000_000n;

/**
 * The vault's pinned stataUnderlying as 0x hex, read from the ledger, so the
 * spec follows whatever pair the deployment sealed in.
 *
 * @param context - The flow context.
 * @returns The underlying ERC20's address.
 */
const pinnedUnderlying = async (context: VaultContext): Promise<string> => {
  const state = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  return `0x${bytesToHex(state.stataUnderlying)}`;
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault supply refund e2e: a reverted wrapper deposit re-mints the underlying",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: user EVM account holds the supplied underlying, vault EVM account holds the supply gas budget",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const context = await session.vaultContext();
        const underlying = await pinnedUnderlying(context);

        // The user's derived account pays the deposit sweep's gas and supplies
        // the deposited underlying. A resumed deposit already swept it.
        const userEth = await getEthBalance(rpcUrl, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
        );
        expect(userEth, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.01"),
        );
        const required = env.SUPPLY_REFUND_DEPOSIT_REQUEST_ID === undefined ? SUPPLY_AMOUNT : 0n;
        const { balance, decimals } = await getErc20Balance(rpcUrl, underlying, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(balance, required, decimals, underlying)} (supplied amount)`,
        );
        expect(
          balance,
          `fund ${userAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${underlying} on EVM`,
        ).toBeGreaterThanOrEqual(required);

        // The vault's derived account sends the doomed deposit itself (and the
        // drain before it): require the fee-cap budget the vault's gas settings
        // stamp on a supply. Actual spend sits far below the cap: a reverted
        // deposit burns a fraction of its limit and the drain rides the margin.
        const { gasLimit, maxFeePerGas } = vaultGasEnvelope(
          await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
          "supply",
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
      "arrange: deposit round trip mints the shielded underlying the doomed supply will burn",
      async () => {
        const context = await session.vaultContext();
        const { requestId } = await runDepositRoundTrip(session, {
          amount: SUPPLY_AMOUNT,
          erc20Address: await pinnedUnderlying(context),
          reuseRequestId: env.SUPPLY_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete: the caller holds ${String(SUPPLY_AMOUNT)} base units of shielded underlying.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  SUPPLY_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "arrange: drain the vault's EVM underlying balance (fakenet-only) so the wrapper deposit must revert",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const context = await session.vaultContext();
        const underlying = await pinnedUnderlying(context);

        // Send the vault's FULL live underlying balance (the arrange sweep plus
        // any prior-run leftovers) back to the user's derived account. A zero
        // balance means a prior aborted run already drained it.
        const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"), underlying);
        if (drained === 0n) {
          logSkip("drain", "the vault's derived account already holds none of the underlying");
        }

        const { balance } = await getErc20Balance(rpcUrl, underlying, vaultAddress);
        expect(
          balance,
          `the vault ${vaultAddress} must hold NONE of ${underlying} so the ${String(SUPPLY_AMOUNT)}-unit deposit reverts`,
        ).toBe(0n);
      },
      3 * MINUTE,
    );

    // Populated by the start stage (or SUPPLY_REFUND_SUPPLY_REQUEST_ID) for the
    // later stages.
    let supplyRequestId: RequestIdHex;

    it(
      "supply: burn the shielded underlying for a deposit the vault cannot fund",
      async () => {
        if (env.SUPPLY_REFUND_SUPPLY_REQUEST_ID) {
          supplyRequestId = env.SUPPLY_REFUND_SUPPLY_REQUEST_ID as RequestIdHex;
          logSkip(
            "supply",
            `SUPPLY_REFUND_SUPPLY_REQUEST_ID present, resuming supply '${supplyRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();

        // The drain put the vault account's nonce back, so the nonce the flush
        // assigns is the account's next expected tx.
        supplyRequestId = await startSupply(context, { amount: SUPPLY_AMOUNT });
        expect(supplyRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          "Doomed supply request recorded on the vault ledger:",
          "",
          `  request id: ${supplyRequestId}`,
          "",
          "The caller's shielded underlying is burned. If a later step dies,",
          `resume with SUPPLY_REFUND_SUPPLY_REQUEST_ID=${supplyRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedSupplyTransaction: Transaction;

    it(
      "pollSignatureResponse: the MPC signs the doomed wrapper deposit",
      async () => {
        expect(supplyRequestId).toBeDefined();

        const context = await session.vaultContext();
        signedSupplyTransaction = await pollSignatureResponse(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
        });

        banner([
          `MPC signed response for doomed supply ${supplyRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedSupplyTransaction)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast the doomed deposit: it mines and REVERTS, so broadcastEvm throws",
      async () => {
        expect(signedSupplyTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm cannot return normally here: the wrapper's transferFrom
        // exceeds the vault's (zero) underlying balance, so the deposit mines
        // with `status 0` and broadcastEvm surfaces that as its
        // reverted-on-chain error, also on reruns, where the already-mined
        // reverted receipt short-circuits to the same throw. The mined receipt
        // is what the responder attests from.
        await expect(
          broadcastEvm(context, { transaction: signedSupplyTransaction }),
        ).rejects.toThrow(/reverted on-chain/);

        banner([
          `Doomed deposit ${signedTxHash(signedSupplyTransaction)} mined and reverted, as arranged.`,
          "",
          "The responder should observe the status-0 receipt and post its",
          "failed attestation (an empty output under OutputKind.failed) on",
          "its next poll.",
        ]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let supplyAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests the deposit as FAILED",
      async () => {
        expect(supplyRequestId).toBeDefined();

        // A post declaring a failure is checked over the empty output the
        // protocol attests: no trace is needed to match it.
        const context = await session.vaultContext();
        supplyAttestation = await pollRespondBidirectional(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
        });

        expect(
          supplyAttestation.event.outputKind,
          "a mined revert must be attested under OutputKind.failed",
        ).toBe(OutputKind.failed);
        expect(supplyAttestation.serializedOutput, "a failure's output is empty").toHaveLength(0);

        banner([
          `Found failure attestation for doomed supply ${supplyRequestId}:`,
          "",
          `  output kind:  ${OutputKind[supplyAttestation.event.outputKind]} (signature-verified)`,
          `  block height: ${String(supplyAttestation.event.blockHeight)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeSupply: the failure attestation re-mints the burned underlying and consumes the request",
      async () => {
        // Settling queues the failure at width 0, flushes it, and
        // completeSupply takes its failure branch: the wrapper took nothing, so
        // it re-mints the surrendered underlying to the supplier (this
        // session's wallet, which proves the pinned ownership commitment).
        expect(supplyRequestId).toBeDefined();
        expect(supplyAttestation).toBeDefined();

        const context = await session.vaultContext();
        const isRequestOnLedger = async () =>
          (
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            )
          ).bidirectionalSupplyMap.member(requestIdBytes(supplyRequestId));

        // Rerun against a kept contract address: if a prior run already settled
        // this request the entry is gone and completeSupply would reject with
        // "Request not sent", so skip cleanly instead.
        if (!(await isRequestOnLedger())) {
          logSkip(
            "completeSupply",
            `supply ${supplyRequestId} already settled (not on the ledger)`,
          );
          return;
        }

        const color = vaultTokenType(await pinnedUnderlying(context), context.vaultContractAddress);
        const wallet = await session.wallet();
        const balanceBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        await settleSupply(context, supplyAttestation);

        expect(
          await isRequestOnLedger(),
          "completeSupply must consume the request from the ledger",
        ).toBe(false);
        // The re-mint is a coin addressed to this wallet, so its balance shows it.
        const reminted = await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) >= balanceBefore + SUPPLY_AMOUNT,
        );
        expect(reminted.shielded.balances[color] ?? 0n).toBe(balanceBefore + SUPPLY_AMOUNT);

        banner([
          `Supply ${supplyRequestId} settled with a RE-MINT.`,
          "",
          "The vault verified the MPC's failure attestation, re-minted the",
          "burned shielded underlying to the supplier, and removed the request",
          "from its ledger.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
