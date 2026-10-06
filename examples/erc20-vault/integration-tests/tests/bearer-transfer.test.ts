// The bearer-transfer e2e flow: shielded vault tokens are BEARER assets. The
// claim on the locked ERC20 travels with possession of the coin: an ordinary
// wallet-to-wallet Midnight transfer moves it, with no vault involvement and no
// depositor registry. This flow proves the ownership handoff end to end: wallet
// A (the depositor) transfers its ENTIRE shielded vault-token balance to wallet B
// in a plain transfer transaction. A, whose balance is now zero, can no longer
// fund a withdraw (the wallet cannot cover the surrendered coin, so the attempt
// dies client-side). B runs a full withdraw round trip to completion on the
// transferred balance.
//
// Wallet B is a real SPENDING wallet (unlike the claimant-not-caller flow's
// receive-only recipient): it pays its withdraw's start, flushes, queue and
// complete in DUST, so its seed is the `bearer` role wallet the setup resolves
// and funds from root (BEARER_SEED, generated, persisted to .env and topped up
// with dust-registered NIGHT like every role wallet, see the harness's
// wallets.ts). B's session overrides USER_SEED and VAULT_USER_SECRET_KEY
// together (see the false-claimer flow header for why both). The arrange
// deposit's 0.1 USDC leaves the vault's EVM account again through B's withdraw
// to EVM_USER_ADDRESS, so the suite's EVM funds keep cycling. The vault tokens
// left on B beyond the withdrawn amount strand on its seed, like the
// claimant-not-caller recipient's.
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there.
// Recovery from a run that died mid-flow (proof-server OOM): rerun this file
// with BEARER_TRANSFER_DEPOSIT_REQUEST_ID / BEARER_TRANSFER_WITHDRAW_REQUEST_ID
// set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import {
  readVaultLedger,
  VAULT_WITHDRAW_REQUESTS_PATH,
  vaultGasEnvelope,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { submitTransferTransaction, waitForFacadeState } from "@sig-net/midnight-examples-lib";
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

import { formatTokenAmount, fundingSummary } from "../src/evm-logging.ts";
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

// Wallet A, the depositor's session: wallet facade + vault context shared by
// every test in this file (lazily built, so the offline path never touches the
// network), stopped once in afterAll.
const session = createVaultSession(env);

// Wallet B's seed AND identity secret: the `bearer` role wallet's seed serving
// as both, deliberately different from the depositor's USER_SEED /
// VAULT_USER_SECRET_KEY and from the other flows' fixed receive-only seeds
// (`…42`/`…43`). A role wallet specifically because B SPENDS: the setup funds it
// from root with dust-registered NIGHT so it can pay its withdraw's fees on ANY
// network. Both env vars are overridden together: a changed secret under the
// SAME seed would hit midnight-js's persisted private state (midnight-level-db,
// scoped per wallet account) and the stale identity would win. Read leniently at
// module scope: offline (RUN_INTEGRATION_TESTS unset) the injected env is empty
// and the suite skips before any test touches it.
const BEARER_SEED = env.BEARER_SEED ?? "";

// Wallet B, the transferee's session: same lazily-built shape as A's, over the
// same stack, differing ONLY in wallet seed + identity secret.
const bearerSession = createVaultSession({
  ...env,
  USER_SEED: BEARER_SEED,
  VAULT_USER_SECRET_KEY: BEARER_SEED,
});

// One deposit's worth of shielded vault tokens is arranged on A, handed to B in
// a plain transfer, and withdrawn by B: 0.1 USDC, the funding preflight's
// minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

/** The vault-token colour for the suite's ERC20 on the deployed vault. */
const vaultTokenColor = () =>
  vaultTokenType(requireEnv("ERC20_ADDRESS"), requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"));

/** A vault-token amount rendered in the ERC20's own decimals, for the logs. */
const tokenAmount = (amount: bigint): Promise<string> =>
  formatTokenAmount(
    requireEnv("EVM_RPC_URL"),
    requireEnv("ERC20_ADDRESS"),
    requireEnv("EVM_USER_ADDRESS"),
    amount,
  );

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault bearer-transfer e2e: the withdraw claim moves with the coin, wallet to wallet",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await bearerSession.stop();
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

        // B's withdraw transfer is sent FROM the vault's derived account, which
        // pays its own gas: require the fee-cap budget the vault's gas settings
        // stamp on a withdrawal, like the happy-day withdraw leg.
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
      "arrange: deposit round trip mints the shielded vault tokens wallet A will hand to B",
      async () => {
        // Rerun tolerance: what this arrange must deliver is A holding vault
        // tokens WITH the vault's EVM account custodying the matching ERC20.
        // When a prior run's claimed deposit already left both in place, a new
        // deposit is pure cost. Both sides must hold: after a failure-refund
        // style drain, A can hold re-minted tokens while the vault's EVM account
        // is empty, and B's withdraw transfer would revert.
        const walletA = await session.wallet();
        const aBalance =
          (await walletA.facade.waitForSyncedState()).shielded.balances[vaultTokenColor()] ?? 0n;
        const { balance: vaultErc20 } = await getErc20Balance(
          requireEnv("EVM_RPC_URL"),
          requireEnv("ERC20_ADDRESS"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );
        const alreadyArranged = aBalance >= WITHDRAW_AMOUNT && vaultErc20 >= WITHDRAW_AMOUNT;
        let requestId: RequestIdHex | undefined;
        if (alreadyArranged) {
          logSkip(
            "arrange deposit",
            `wallet A already holds ${await tokenAmount(aBalance)} vault tokens and the vault's EVM account holds ${String(vaultErc20)} ERC20`,
          );
        } else {
          ({ requestId } = await runDepositRoundTrip(session, {
            amount: DEPOSIT_AMOUNT,
            reuseRequestId: env.BEARER_TRANSFER_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
          }));

          banner([
            `Arrange deposit ${String(requestId)} complete: wallet A holds ${String(DEPOSIT_AMOUNT)} base units of shielded vault tokens.`,
            "",
            "If a later step dies (e.g. proof-server OOM), resume with",
            `  BEARER_TRANSFER_DEPOSIT_REQUEST_ID=${String(requestId)}`,
          ]);
        }

        // The arrange delivers wallet A's tokens either way: a prior run left
        // them in place, or this run minted them through a deposit round trip.
        expect(
          alreadyArranged || requestId !== undefined,
          "arrange must either find wallet A already funded or complete a deposit round trip",
        ).toBe(true);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "bearer transfer: wallet A hands its ENTIRE shielded vault-token balance to wallet B in a plain transfer",
      async () => {
        const color = vaultTokenColor();
        const walletA = await session.wallet();
        const walletB = await bearerSession.wallet();

        const aBalance = (await walletA.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        const stateB = await walletB.facade.waitForSyncedState();
        const bBalanceBefore = stateB.shielded.balances[color] ?? 0n;
        console.log(`wallet A vault-token balance: ${await tokenAmount(aBalance)}`);
        console.log(`wallet B vault-token balance: ${await tokenAmount(bBalanceBefore)}`);

        if (aBalance === 0n) {
          // Rerun tolerance: a prior run already moved A's balance, and B must
          // already hold it (asserted below) for the rest of the file to run.
          logSkip(
            "bearer transfer",
            "wallet A holds no vault tokens: a prior run already transferred them",
          );
        } else {
          // The handoff itself: an ordinary wallet-to-wallet Midnight transfer
          // of the vault-token colour to B's shielded address. No vault
          // involvement, no contract call, no identity: pure possession.
          await submitTransferTransaction(
            walletA.facade,
            walletA.keys,
            [
              {
                type: "shielded",
                outputs: [
                  {
                    type: color,
                    receiverAddress: stateB.shielded.address,
                    amount: aBalance,
                  },
                ],
              },
            ],
            getMidnightNodeConfig(env).networkId,
          );

          await waitForFacadeState(
            walletA.facade,
            (state) => (state.shielded.balances[color] ?? 0n) === 0n,
          );
          await waitForFacadeState(
            walletB.facade,
            (state) => (state.shielded.balances[color] ?? 0n) >= bBalanceBefore + aBalance,
          );
        }

        const bBalanceAfter =
          (await walletB.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        expect(
          bBalanceAfter,
          "wallet B must hold at least the withdraw amount after the handoff",
        ).toBeGreaterThanOrEqual(WITHDRAW_AMOUNT);

        banner([
          "Bearer handoff complete: the vault-token balance moved A → B:",
          "",
          `  wallet A balance: ${await tokenAmount(aBalance)} → 0`,
          `  wallet B balance: ${await tokenAmount(bBalanceBefore)} → ${await tokenAmount(bBalanceAfter)}`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      "old owner: wallet A (balance 0) can no longer fund a withdraw, and no request reaches the ledger",
      async () => {
        const color = vaultTokenColor();
        const walletA = await session.wallet();
        expect(
          (await walletA.facade.waitForSyncedState()).shielded.balances[color] ?? 0n,
          "wallet A must hold no vault tokens after the handoff",
        ).toBe(0n);

        const context = await session.vaultContext();
        const readQueuedRequests = async () =>
          (
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            )
          ).inputRequestBuffer.size();
        const queuedBefore = await readQueuedRequests();

        // The `startWithdraw` circuit demands a surrendered coin of the full
        // amount. A's wallet holds none of the colour, so balancing cannot fund
        // it and the attempt dies client-side: the tx is never submitted.
        await expect(
          startWithdraw(context, {
            amount: WITHDRAW_AMOUNT,
            destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
          }),
        ).rejects.toThrow(/[Ii]nsufficient funds/);

        // Client-side death leaves no trace: the input request buffer is unchanged.
        expect(
          await readQueuedRequests(),
          "the failed withdraw must not queue a request on the ledger",
        ).toBe(queuedBefore);

        banner([
          "Wallet A can no longer withdraw: its shielded vault-token balance is 0,",
          "so the surrendered coin cannot be funded. The attempt died client-side,",
          "and no request reached the vault ledger.",
        ]);
      },
      15 * MINUTE,
    );

    // Populated by the request leg (or BEARER_TRANSFER_WITHDRAW_REQUEST_ID) for
    // the subsequent stages.
    let withdrawRequestId: RequestIdHex;

    it(
      "new owner: wallet B burns the transferred vault tokens in a withdraw",
      async () => {
        if (env.BEARER_TRANSFER_WITHDRAW_REQUEST_ID) {
          withdrawRequestId = env.BEARER_TRANSFER_WITHDRAW_REQUEST_ID as RequestIdHex;
          logSkip(
            "withdraw",
            `BEARER_TRANSFER_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`,
          );
          return;
        }

        const context = await bearerSession.vaultContext();

        // The withdraw tx sender is the VAULT's derived EVM account, at the
        // nonce the flush assigns. The destination is the user's derived
        // account, so the suite's funds cycle.
        withdrawRequestId = await startWithdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
        });
        expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          "Wallet B's withdraw request recorded on the vault ledger:",
          "",
          `  request id: ${withdrawRequestId}`,
          "",
          "B's transferred vault tokens are burned: same coins, new owner, no",
          "vault-side registry consulted. If a later step dies, resume with",
          `  BEARER_TRANSFER_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
        ]);
      },
      15 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedWithdrawTransaction: Transaction;

    it(
      "pollSignatureResponse: the MPC signs wallet B's withdraw transfer",
      async () => {
        expect(withdrawRequestId).toBeDefined();

        const context = await bearerSession.vaultContext();
        // Withdraw transfers are signed by the VAULT's derived account.
        signedWithdrawTransaction = await pollSignatureResponse(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });

        banner([
          `MPC signed response for wallet B's withdraw ${withdrawRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedWithdrawTransaction)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast withdraw evm txn: the ERC20 leaves the vault on the EVM side",
      async () => {
        expect(signedWithdrawTransaction).toBeDefined();
        const context = await bearerSession.vaultContext();

        // broadcastEvm waits for one confirmation and throws if the tx
        // reverted. An already-mined tx (rerun) short-circuits.
        const receipt = await broadcastEvm(context, { transaction: signedWithdrawTransaction });

        banner([
          `Withdraw transaction mined on EVM: ${receipt.hash}`,
          "",
          `The vault's derived account transferred ${String(WITHDRAW_AMOUNT)} base units`,
          `back to ${requireEnv("EVM_USER_ADDRESS")}.`,
        ]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let withdrawAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests wallet B's transfer as succeeded",
      async () => {
        expect(withdrawRequestId).toBeDefined();

        const context = await bearerSession.vaultContext();
        withdrawAttestation = await pollRespondBidirectional(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });

        // The broadcast step saw the transfer mine, so the MPC must attest
        // success (the 1-byte 0x01 result), not a failure kind.
        expect(
          withdrawAttestation.succeeded,
          "the MPC must attest wallet B's withdraw transfer as succeeded",
        ).toBe(true);

        banner([`Found success attestation for wallet B's withdraw ${withdrawRequestId}.`]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeWithdraw: wallet B settles its withdrawal and the request is consumed",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        expect(withdrawAttestation).toBeDefined();

        const context = await bearerSession.vaultContext();
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

        await settleWithdraw(context, withdrawAttestation);

        expect(
          await isRequestOnLedger(),
          "completeWithdraw must consume the request from the ledger",
        ).toBe(false);

        banner([
          `Wallet B's withdraw ${withdrawRequestId} settled (success, no re-mint).`,
          "",
          "The ownership handoff is proven end to end: value deposited by A,",
          "handed to B in a plain wallet transfer, withdrawn to completion by B,",
          "while A, holding nothing, could not fund a withdraw at all.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
