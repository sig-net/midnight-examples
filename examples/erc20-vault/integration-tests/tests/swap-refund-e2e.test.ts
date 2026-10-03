// The swap refund e2e flow: a swap that REVERTS on-chain must end with the MPC
// attesting it as failed over an empty output, and `completeSwap`'s failure branch
// re-minting the burned shielded USDC cap to the caller and consuming the request.
//
// Failure-injection strategy (deliberate, deterministic): cap the spend at HALF a
// live quote for the exact EURC output, so `exactOutputSingle` must spend more than
// `amountInMaximum` and the router reverts. The responder attests a mined
// `status 0` receipt as failed. The spec runs on the Sepolia fork the setup
// pipeline verifies, where the router is deployed. The swap-side twin of
// tests/deposit-withdrawal-failure-refund.test.ts.
//
// The arrange stage runs a full deposit round trip first (the caller must hold
// the shielded USDC it surrenders). Run AFTER tests/approve-e2e.test.ts
// (FILE_ORDER), so the swap reverts on its cap, not on a missing allowance.
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file with
// SWAP_REFUND_DEPOSIT_REQUEST_ID / SWAP_REFUND_SWAP_REQUEST_ID set to the ids the
// failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_SWAP_REQUESTS_PATH,
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
import { quoteExactOutputSingle } from "../src/evm-swap.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleSwap } from "../src/flows/complete-swap.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startSwap } from "../src/flows/start-swap.ts";
import { SEPOLIA_EURC } from "../src/fork-funding.ts";
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

// Wallet facade + vault context shared by every test in this file (lazily
// built, so the offline path never touches the network), stopped once in
// afterAll.
const session = createVaultSession(env);

// The USDC/EURC pool's fee tier.
const FEE = 500n;
// exactOutput: ask for EXACTLY 3 EURC while capping the spend below its cost.
const AMOUNT_OUT = 3_000_000n;

/**
 * The input cap the doomed swap surrenders: half the live quote for
 * {@link AMOUNT_OUT}, below its real cost whatever the fork pool's price.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param erc20Address - The sold ERC20.
 * @returns The `amountInMaximum` the router must revert above.
 */
const doomedCap = async (rpcUrl: string, erc20Address: string): Promise<bigint> =>
  (await quoteExactOutputSingle(rpcUrl, erc20Address, SEPOLIA_EURC, FEE, AMOUNT_OUT)).amountIn / 2n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap refund e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the deposited cap, vault EVM account holds the swap gas budget",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const userAddress = requireEnv("EVM_USER_ADDRESS");
      const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      // The user's derived account pays the sweep gas and supplies the deposited ERC20.
      const userEth = await getEthBalance(rpcUrl, userAddress);
      console.log(
        `${userAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
      );
      expect(userEth, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
        parseEther("0.01"),
      );
      // A resumed deposit already swept its ERC20, so nothing is required then.
      const required = env.SWAP_REFUND_DEPOSIT_REQUEST_ID
        ? 0n
        : await doomedCap(rpcUrl, erc20Address);
      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(
        `${userAddress}: ${fundingSummary(balance, required, decimals, erc20Address)} (deposited cap)`,
      );
      expect(
        balance,
        `fund ${userAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${erc20Address} on EVM`,
      ).toBeGreaterThanOrEqual(required);

      // The vault's derived account sends the doomed swap, at the vault's swap gas
      // settings. A revert burns less than the cap, which is the budget required.
      const context = await session.vaultContext();
      const { gasLimit, maxFeePerGas } = vaultGasEnvelope(
        await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
        "swap",
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

  // Populated by the arrange stage for the start stage.
  let amountInMaximum: bigint;

  it(
    "arrange: deposit round trip mints the shielded USDC the doomed swap will surrender",
    async () => {
      amountInMaximum = await doomedCap(requireEnv("EVM_RPC_URL"), requireEnv("ERC20_ADDRESS"));
      const { requestId } = await runDepositRoundTrip(session, {
        amount: amountInMaximum,
        reuseRequestId: env.SWAP_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
      });

      banner([
        `Arrange deposit ${requestId} complete: the caller holds the doomed cap of ${String(amountInMaximum)} base units.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SWAP_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);

      expect(requestId).toMatch(/^[0-9a-f]{64}$/);
    },
    2 * POLL_TIMEOUT_MS + 15 * MINUTE,
  );

  // Populated by the start stage (or SWAP_REFUND_SWAP_REQUEST_ID) for the later stages.
  let swapRequestId: RequestIdHex;

  it(
    "startSwap: burn the shielded USDC cap for a buy it cannot pay for",
    async () => {
      if (env.SWAP_REFUND_SWAP_REQUEST_ID) {
        swapRequestId = env.SWAP_REFUND_SWAP_REQUEST_ID as RequestIdHex;
        logSkip("swap", `SWAP_REFUND_SWAP_REQUEST_ID present, resuming swap '${swapRequestId}'`);
        return;
      }
      expect(amountInMaximum).toBeDefined();

      const context = await session.vaultContext();
      swapRequestId = await startSwap(context, {
        erc20AddressOut: SEPOLIA_EURC,
        fee: FEE,
        amountOut: AMOUNT_OUT,
        amountInMaximum,
      });
      expect(swapRequestId).toMatch(/^[0-9a-f]{64}$/);

      banner([
        `Doomed swap request recorded on the vault ledger:`,
        "",
        `  request id: ${swapRequestId}`,
        "",
        "The caller's shielded USDC cap is burned. If a later step dies,",
        `resume with SWAP_REFUND_SWAP_REQUEST_ID=${swapRequestId}`,
      ]);
    },
    5 * MINUTE,
  );

  // Populated by the poll step below for the broadcast step.
  let signedSwapTransaction: Transaction;

  it(
    "pollSignatureResponse: the MPC signs the doomed swap with the vault's account",
    async () => {
      expect(swapRequestId).toBeDefined();

      const context = await session.vaultContext();
      signedSwapTransaction = await pollSignatureResponse(context, {
        requestId: swapRequestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
        requestsPath: VAULT_SWAP_REQUESTS_PATH,
      });

      banner([
        `MPC signed response for doomed swap ${swapRequestId} found from Signet Contract.`,
        "",
        `Signed tx hash: ${signedTxHash(signedSwapTransaction)}`,
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "broadcast the doomed swap: it mines and REVERTS on its cap",
    async () => {
      expect(signedSwapTransaction).toBeDefined();
      const context = await session.vaultContext();

      // The router must spend more than amountInMaximum for the exact output, so
      // the swap mines with `status 0`: a valid outcome the MPC attests as failed.
      // A rerun finds the same mined receipt.
      const receipt = await broadcastEvm(context, {
        transaction: signedSwapTransaction,
        tolerateRevert: true,
      });
      expect(receipt.status, "the capped swap must revert on-chain").toBe(0);

      banner([
        `Doomed swap ${signedTxHash(signedSwapTransaction)} mined and reverted, as arranged.`,
        "",
        "The responder should observe the status-0 receipt and post its",
        "failed attestation (an empty output under OutputKind.failed) on",
        "its next poll.",
      ]);
    },
    3 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let swapAttestation: RespondOutcome;

  it(
    "pollRespondBidirectional: the MPC attests the swap as FAILED",
    async () => {
      expect(swapRequestId).toBeDefined();

      // A post declaring a failure is checked over the empty output the protocol
      // attests: no trace is needed to match it.
      const context = await session.vaultContext();
      swapAttestation = await pollRespondBidirectional(context, {
        requestId: swapRequestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_SWAP_REQUESTS_PATH,
      });

      expect(
        swapAttestation.event.outputKind,
        "a mined revert must be attested under OutputKind.failed",
      ).toBe(OutputKind.failed);
      expect(swapAttestation.serializedOutput, "a failure's output is empty").toHaveLength(0);

      banner([
        `Found failure attestation for doomed swap ${swapRequestId}:`,
        "",
        `  output kind:  ${OutputKind[swapAttestation.event.outputKind]} (signature-verified)`,
        `  block height: ${String(swapAttestation.event.blockHeight)}`,
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "completeSwap: the failure attestation re-mints the burned USDC cap and consumes the request",
    async () => {
      expect(swapRequestId).toBeDefined();
      expect(swapAttestation).toBeDefined();

      const context = await session.vaultContext();
      const requestIndex = requestIdBytes(swapRequestId);
      const isRequestOnLedger = async () =>
        (
          await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)
        ).bidirectionalSwapMap.member(requestIndex);

      // Rerun against a kept contract address: if a prior run already settled
      // this request the entry is gone and completeSwap would reject with
      // "Request not sent", so skip cleanly instead.
      if (!(await isRequestOnLedger())) {
        logSkip("completeSwap", `swap ${swapRequestId} already settled (not on the ledger)`);
        return;
      }

      const color = vaultTokenType(
        requireEnv("ERC20_ADDRESS"),
        requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      );
      const wallet = await session.wallet();
      const balanceBefore =
        (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

      const { request, amountIn } = await settleSwap(context, swapAttestation);

      expect(
        await isRequestOnLedger(),
        "completeSwap must consume the request from the ledger",
      ).toBe(false);
      expect(amountIn, "completeSwap must take its failure branch").toBeUndefined();
      // The re-mint is a coin addressed to this wallet, so its balance shows it.
      const reminted = await waitForFacadeState(
        wallet.facade,
        (state) =>
          (state.shielded.balances[color] ?? 0n) >= balanceBefore + request.amountInMaximum,
      );
      expect(reminted.shielded.balances[color] ?? 0n).toBe(balanceBefore + request.amountInMaximum);

      banner([
        `Swap ${swapRequestId} settled with a RE-MINT.`,
        "",
        "The vault verified the MPC's failure attestation, re-minted the",
        `burned ${String(request.amountInMaximum)} USDC cap to the swapper, and removed`,
        "the request from its ledger.",
      ]);
    },
    15 * MINUTE,
  );
});
