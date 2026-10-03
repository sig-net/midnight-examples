// The swap e2e flow: the caller swaps shielded vault tokens of the suite's ERC20
// (USDC) for an exact amount of EURC. `startSwap` burns the surrendered USDC coin,
// the vault's own EVM account runs `exactOutputSingle` on the pinned Uniswap router,
// the MPC attests the input the swap spent, and `completeSwap` mints the exact EURC
// bought plus the unspent USDC as change. The spec runs on the Sepolia fork the
// setup pipeline verifies: the router is deployed there, and the fork's USDC/EURC
// pool prices the swap, so the input cap comes from a live quote.
//
// The arrange stage runs a full deposit round trip first (the caller must hold
// the shielded USDC it surrenders, and the vault's EVM account the USDC the router
// spends). The router spends the vault account's USDC under the allowance
// tests/approve-e2e.test.ts grants, so run AFTER it (FILE_ORDER). Recovery from a
// run that died mid-flow (proof-server OOM): rerun this file with
// SWAP_E2E_DEPOSIT_REQUEST_ID / SWAP_E2E_SWAP_REQUEST_ID set to the ids the failed
// run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
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
// exactOutput: receive EXACTLY 1 EURC. The fork pool's price is arbitrary (thin
// testnet liquidity, not ~1:1), so the input cap is sized from a LIVE quote, with
// generous headroom so the swap fits and leaves change.
const AMOUNT_OUT = 1_000_000n;
const CAP_SLIPPAGE_BPS = 1000n;

/**
 * The input cap the swap surrenders: the live quote for {@link AMOUNT_OUT} plus
 * {@link CAP_SLIPPAGE_BPS} of headroom.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param erc20Address - The sold ERC20.
 * @returns The quoted `amountInMaximum`.
 */
const quotedCap = async (rpcUrl: string, erc20Address: string): Promise<bigint> =>
  (
    await quoteExactOutputSingle(
      rpcUrl,
      erc20Address,
      SEPOLIA_EURC,
      FEE,
      AMOUNT_OUT,
      CAP_SLIPPAGE_BPS,
    )
  ).amountInMaximum;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault swap e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the quoted deposit, vault EVM account holds the swap gas budget",
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
      const required = env.SWAP_E2E_DEPOSIT_REQUEST_ID ? 0n : await quotedCap(rpcUrl, erc20Address);
      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(
        `${userAddress}: ${fundingSummary(balance, required, decimals, erc20Address)} (quoted deposit)`,
      );
      expect(
        balance,
        `fund ${userAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${erc20Address} on EVM`,
      ).toBeGreaterThanOrEqual(required);

      // The vault's derived account sends the swap, at the vault's swap gas settings.
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
    "arrange: deposit round trip mints the shielded USDC the swap will surrender",
    async () => {
      amountInMaximum = await quotedCap(requireEnv("EVM_RPC_URL"), requireEnv("ERC20_ADDRESS"));
      const { requestId } = await runDepositRoundTrip(session, {
        amount: amountInMaximum,
        reuseRequestId: env.SWAP_E2E_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
      });

      banner([
        `Arrange deposit ${requestId} complete: the caller holds the quoted cap of ${String(amountInMaximum)} base units.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  SWAP_E2E_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);

      expect(requestId).toMatch(/^[0-9a-f]{64}$/);
    },
    2 * POLL_TIMEOUT_MS + 15 * MINUTE,
  );

  // Populated by the start stage (or SWAP_E2E_SWAP_REQUEST_ID) for the later stages.
  let swapRequestId: RequestIdHex;

  it(
    "startSwap: burn the shielded USDC cap for an exact EURC buy",
    async () => {
      if (env.SWAP_E2E_SWAP_REQUEST_ID) {
        swapRequestId = env.SWAP_E2E_SWAP_REQUEST_ID as RequestIdHex;
        logSkip("swap", `SWAP_E2E_SWAP_REQUEST_ID present, resuming swap '${swapRequestId}'`);
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
        `Swap request recorded on the vault ledger:`,
        "",
        `  request id: ${swapRequestId}`,
        "",
        "The caller's shielded USDC cap is burned. If a later step dies,",
        `resume with SWAP_E2E_SWAP_REQUEST_ID=${swapRequestId}`,
      ]);
    },
    5 * MINUTE,
  );

  // Populated by the poll step below for the broadcast step.
  let signedSwapTransaction: Transaction;

  it(
    "pollSignatureResponse: the MPC signs the swap with the vault's account",
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
        `MPC signed response for swap ${swapRequestId} found from Signet Contract.`,
        "",
        `Signed tx hash: ${signedTxHash(signedSwapTransaction)}`,
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "broadcast swap evm txn: the exactOutputSingle mines on the EVM side",
    async () => {
      expect(signedSwapTransaction).toBeDefined();
      const context = await session.vaultContext();

      // broadcastEvm waits for one confirmation and throws if the swap reverted
      // (an unapproved router, or a pool that moved past the cap). An
      // already-mined tx (rerun) short-circuits.
      const receipt = await broadcastEvm(context, { transaction: signedSwapTransaction });

      banner([`Swap ${swapRequestId} mined on EVM: ${receipt.hash}`]);
    },
    3 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let swapAttestation: RespondOutcome;

  it(
    "pollRespondBidirectional: the MPC attests the swap as executed with the input it spent",
    async () => {
      expect(swapRequestId).toBeDefined();

      const context = await session.vaultContext();
      swapAttestation = await pollRespondBidirectional(context, {
        requestId: swapRequestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_SWAP_REQUESTS_PATH,
      });

      expect(
        swapAttestation.event.outputKind,
        "the broadcast step saw the swap mine, so the MPC must attest it executed",
      ).toBe(OutputKind.executed);
      const amountIn = pureCircuits.swapAmountIn(swapAttestation.serializedOutput);
      expect(amountIn, "an executed swap attests the input it spent").toBeGreaterThan(0n);

      banner([
        `Found execution attestation for swap ${swapRequestId}:`,
        "",
        `  amountIn:     ${String(amountIn)} (signature-verified)`,
        `  block height: ${String(swapAttestation.event.blockHeight)}`,
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "completeSwap: mints the exact EURC bought and the unspent USDC change, and consumes the request",
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

      const vaultContractAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const inColor = vaultTokenType(requireEnv("ERC20_ADDRESS"), vaultContractAddress);
      const outColor = vaultTokenType(SEPOLIA_EURC, vaultContractAddress);
      const wallet = await session.wallet();
      const before = (await wallet.facade.waitForSyncedState()).shielded.balances;
      const inBefore = before[inColor] ?? 0n;
      const outBefore = before[outColor] ?? 0n;

      const { request, amountIn } = await settleSwap(context, swapAttestation);

      expect(
        await isRequestOnLedger(),
        "completeSwap must consume the request from the ledger",
      ).toBe(false);
      if (amountIn === undefined) {
        throw new Error(
          "completeSwap took its failure branch, but the attestation step saw the swap execute",
        );
      }
      // The request's own cap, read from the ledger, so a resumed swap is checked too.
      expect(amountIn, "the swap spent less than its cap, so change exists").toBeLessThan(
        request.amountInMaximum,
      );
      const change = request.amountInMaximum - amountIn;
      // Both mints are coins addressed to this wallet, so its balances show them.
      const minted = await waitForFacadeState(
        wallet.facade,
        (state) =>
          (state.shielded.balances[outColor] ?? 0n) >= outBefore + request.amountOut &&
          (state.shielded.balances[inColor] ?? 0n) >= inBefore + change,
      );
      expect(minted.shielded.balances[outColor] ?? 0n).toBe(outBefore + request.amountOut);
      expect(minted.shielded.balances[inColor] ?? 0n).toBe(inBefore + change);

      banner([
        `Swap ${swapRequestId} settled.`,
        "",
        `  bought: ${String(request.amountOut)} EURC`,
        `  spent:  ${String(amountIn)} USDC of the ${String(request.amountInMaximum)} cap`,
        `  change: ${String(change)} USDC re-minted`,
      ]);
    },
    15 * MINUTE,
  );
});
