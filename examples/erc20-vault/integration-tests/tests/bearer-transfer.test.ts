// The bearer-transfer e2e flow: shielded vault tokens are BEARER assets. The
// claim on the locked ERC20 travels with possession of the coin — an
// ordinary wallet-to-wallet Midnight transfer moves it, with no vault
// involvement and no depositor registry. This flow proves the ownership
// handoff end to end: wallet A (the depositor) transfers its ENTIRE shielded
// vault-token balance to wallet B in a plain transfer transaction; A — whose
// balance is now zero — can no longer fund a withdraw (the wallet cannot
// cover the surrendered coin, so the attempt dies client-side); B runs a
// full withdraw round trip to completion on the transferred balance.
//
// Wallet B is a real SPENDING wallet (unlike the claimant-not-caller flow's
// receive-only recipient): its withdraw pays fees in DUST, so its seed is
// the `bearer` role wallet the setup resolves and funds from root
// (BEARER_SEED — generated + persisted to .env and topped up with
// dust-registered NIGHT like every role wallet, see the harness's
// wallets.ts). B's session overrides USER_SEED and VAULT_USER_SECRET_KEY
// together (see the false-claimer flow header for why both). The arrange
// deposit's 0.1 USDC leaves the vault's EVM account again through B's
// withdraw to EVM_USER_ADDRESS, so the suite's EVM funds keep cycling; the
// vault tokens left on B beyond the withdrawn amount strand on its seed,
// like the claimant-not-caller recipient's.
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialize lives
// there. Recovery from a run that died mid-flow (proof-server OOM): rerun
// this file with BEARER_TRANSFER_DEPOSIT_REQUEST_ID /
// BEARER_TRANSFER_WITHDRAW_REQUEST_ID set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.

import {
  submitTransferTransaction,
  waitForFacadeState,
} from "@midnight-examples/lib";
import {
  executionSucceeded,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectionalEvent,
} from "@sig-net/midnight";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  getTransactionNonce,
  logSkip,
  requireEnv as requireEnvOf,
} from "@midnight-examples/test-harness";
import { injectE2eEnv, installFlowHooks } from "@midnight-examples/test-harness/flow-hooks";

import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { completeWithdraw } from "../src/flows/complete-withdraw.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { pollRespondBidirectional } from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { withdraw } from "../src/flows/withdraw.ts";
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

// Wallet A — the depositor's session: wallet facade + vault context shared by
// every test in this file (lazily built, so the offline path never touches
// the network); stopped once in afterAll.
const session = createVaultSession(env);

// Wallet B's seed AND identity secret: the `bearer` role wallet's seed
// serving as both, deliberately different from the depositor's USER_SEED /
// VAULT_USER_SECRET_KEY and from the other flows' fixed receive-only seeds
// (`…42`/`…43`). A role wallet specifically because B SPENDS: the setup
// funds it from root with dust-registered NIGHT so it can pay its
// withdraw's fees on ANY network. Both env vars are overridden together —
// a changed secret under the SAME seed would hit midnight-js's persisted
// private state (midnight-level-db, scoped per wallet account) and the
// stale identity would win. Read leniently at module scope: offline
// (RUN_INTEGRATION_TESTS unset) the injected env is empty and the suite
// skips before any test touches it.
const BEARER_SEED = env.BEARER_SEED ?? "";

// Wallet B — the transferee's session: same lazily-built shape as A's, over
// the same stack, differing ONLY in wallet seed + identity secret.
const bearerSession = createVaultSession({
  ...env,
  USER_SEED: BEARER_SEED,
  VAULT_USER_SECRET_KEY: BEARER_SEED,
});

// One deposit's worth of shielded vault tokens is arranged on A, handed to B
// in a plain transfer, and withdrawn by B — 0.1 USDC, the funding
// preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

/** The vault-token color for the suite's ERC20 on the deployed vault. */
const vaultTokenColor = () =>
  vaultTokenType(requireEnv("ERC20_ADDRESS"), requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault bearer-transfer e2e: the withdraw claim moves with the coin, wallet to wallet", () => {
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
      console.log(`${userAddress} ETH balance: ${userEth} wei`);
      expect(userEth, `fund ${userAddress} with >= 0.009 ETH on EVM`).toBeGreaterThanOrEqual(
        parseEther("0.009"),
      );
      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(`${userAddress} balance on ${erc20Address}: ${balance} (decimals ${decimals})`);
      expect(balance, `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`).toBeGreaterThanOrEqual(
        DEPOSIT_AMOUNT,
      );

      // B's withdraw transfer is sent FROM the vault's derived account, which
      // pays its own gas: require the fee-cap budget of one MPC-signed ERC20
      // transfer, like the happy-day withdraw leg.
      const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS;
      const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
      console.log(`${vaultAddress} ETH balance: ${vaultEth} wei (withdraw gas budget: ${gasBudget} wei)`);
      expect(
        vaultEth,
        `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
      ).toBeGreaterThanOrEqual(gasBudget);
    },
    MINUTE,
  );

  it(
    "vault-initialized preflight: the vault contract is initialized (read-only)",
    async () => {
      const context = await session.vaultContext();
      const state = await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);
      expect(
        state.initialized,
        "vault is not initialized — run tests/happy-day-e2e.test.ts first (or initialize the vault)",
      ).toBe(1n);
    },
    5 * MINUTE,
  );

  it(
    "arrange: deposit round trip mints the shielded vault tokens wallet A will hand to B",
    async () => {
      // Rerun tolerance: what this arrange must deliver is A holding vault
      // tokens WITH the vault's EVM account custodying the matching ERC20 —
      // when a prior run's claimed deposit already left both in place, a new
      // deposit is pure cost. Both sides must hold: after a failure-refund
      // style drain, A can hold refunded tokens while the vault's EVM
      // account is empty, and B's withdraw transfer would revert.
      const walletA = await session.wallet();
      const aBalance = (await walletA.facade.waitForSyncedState()).shielded.balances[vaultTokenColor()] ?? 0n;
      const { balance: vaultErc20 } = await getErc20Balance(
        requireEnv("EVM_RPC_URL"),
        requireEnv("ERC20_ADDRESS"),
        requireEnv("EVM_VAULT_ADDRESS"),
      );
      if (aBalance >= WITHDRAW_AMOUNT && vaultErc20 >= WITHDRAW_AMOUNT) {
        logSkip(
          "arrange deposit",
          `wallet A already holds ${aBalance} vault tokens and the vault's EVM account holds ${vaultErc20} ERC20`,
        );
        return;
      }

      const { requestId } = await runDepositRoundTrip(session, {
        amount: DEPOSIT_AMOUNT,
        reuseRequestId: env.BEARER_TRANSFER_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
      });

      banner([
        `Arrange deposit ${requestId} complete — wallet A holds ${DEPOSIT_AMOUNT} base units of shielded vault tokens.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  BEARER_TRANSFER_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "wallet-B fee preflight: the bearer role wallet holds spendable dust for its withdraw (read-only)",
    async () => {
      const walletB = await bearerSession.wallet();
      const dust = (await walletB.facade.waitForSyncedState()).dust.balance(new Date());
      console.log(`wallet B dust (fee) balance: ${dust}`);
      expect(
        dust,
        "wallet B holds no spendable dust — did the setup's root-funding step fund BEARER_SEED?",
      ).toBeGreaterThan(0n);
    },
    5 * MINUTE,
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
      console.log(`wallet A vault-token balance: ${aBalance}`);
      console.log(`wallet B vault-token balance: ${bBalanceBefore}`);

      if (aBalance === 0n) {
        // Rerun tolerance: a prior run already moved A's balance; B must
        // already hold it (asserted below) for the rest of the file to run.
        logSkip("bearer transfer", "wallet A holds no vault tokens — a prior run already transferred them");
      } else {
        // The handoff itself: an ordinary wallet-to-wallet Midnight transfer
        // of the vault-token color to B's shielded address — no vault
        // involvement, no contract call, no identity: pure possession.
        await submitTransferTransaction(walletA.facade, walletA.keys, [
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
        ]);

        await waitForFacadeState(
          walletA.facade,
          (state) => (state.shielded.balances[color] ?? 0n) === 0n,
        );
        await waitForFacadeState(
          walletB.facade,
          (state) => (state.shielded.balances[color] ?? 0n) >= bBalanceBefore + aBalance,
        );
      }

      const bBalanceAfter = (await walletB.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
      expect(
        bBalanceAfter,
        "wallet B must hold at least the withdraw amount after the handoff",
      ).toBeGreaterThanOrEqual(WITHDRAW_AMOUNT);

      banner([
        "Bearer handoff complete — the vault-token balance moved A → B:",
        "",
        `  wallet A balance: ${aBalance} → 0`,
        `  wallet B balance: ${bBalanceBefore} → ${bBalanceAfter}`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "old owner: wallet A (balance 0) can no longer fund a withdraw — and no request reaches the ledger",
    async () => {
      const color = vaultTokenColor();
      const walletA = await session.wallet();
      expect(
        (await walletA.facade.waitForSyncedState()).shielded.balances[color] ?? 0n,
        "wallet A must hold no vault tokens after the handoff",
      ).toBe(0n);

      const context = await session.vaultContext();
      const readNonce = async () =>
        (await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress)).signetRequestNonce;
      const nonceBefore = await readNonce();

      // The withdraw circuit demands a surrendered coin of the full amount;
      // A's wallet holds none of the color, so balancing cannot fund it and
      // the attempt dies client-side — the tx is never submitted.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));
      await expect(
        withdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
          evmNonce,
        }),
      ).rejects.toThrow(/[Ii]nsufficient funds/);

      // Client-side death leaves no trace: the request counter is unchanged.
      expect(
        await readNonce(),
        "the failed withdraw must not record a request on the ledger",
      ).toBe(nonceBefore);

      banner([
        "Wallet A can no longer withdraw: its shielded vault-token balance is 0,",
        "so the surrendered coin cannot be funded. The attempt died client-side;",
        "no request reached the vault ledger.",
      ]);
    },
    15 * MINUTE,
  );

  // Populated by the request leg (or BEARER_TRANSFER_WITHDRAW_REQUEST_ID)
  // for the subsequent stages.
  let withdrawRequestId: RequestIdHex;

  it(
    "new owner: wallet B escrows the transferred vault tokens in a withdraw",
    async () => {
      if (env.BEARER_TRANSFER_WITHDRAW_REQUEST_ID) {
        withdrawRequestId = env.BEARER_TRANSFER_WITHDRAW_REQUEST_ID as RequestIdHex;
        logSkip("withdraw", `BEARER_TRANSFER_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`);
        return;
      }

      const context = await bearerSession.vaultContext();

      // The withdraw tx sender is the VAULT's derived EVM account; its next
      // nonce comes from the chain. The destination is the user's derived
      // account, so the suite's funds cycle.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));

      withdrawRequestId = await withdraw(context, {
        amount: WITHDRAW_AMOUNT,
        destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
        evmNonce,
      });
      expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

      banner([
        "Wallet B's withdraw request recorded on the vault ledger:",
        "",
        `  request id: ${withdrawRequestId}`,
        "",
        "B's transferred vault tokens are escrowed — same coins, new owner,",
        "no vault-side registry consulted. If a later step dies, resume with",
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
        timeoutMs: 2 * MINUTE,
        expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
      });

      banner([
        `MPC signed response for wallet B's withdraw ${withdrawRequestId} found from Signet Contract.`,
        "",
        `Signed tx hash: ${signedWithdrawTransaction.hash}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "broadcast withdraw evm txn: the ERC20 leaves the vault on the EVM side",
    async () => {
      expect(signedWithdrawTransaction).toBeDefined();
      const context = await bearerSession.vaultContext();

      // broadcastEvm waits for one confirmation and throws if the tx
      // reverted; an already-mined tx (rerun) short-circuits.
      const txHash = await broadcastEvm(context, { transaction: signedWithdrawTransaction });

      banner([
        `Withdraw transaction mined on EVM: ${txHash}`,
        "",
        `The vault's derived account transferred ${WITHDRAW_AMOUNT} base units`,
        `back to ${requireEnv("EVM_USER_ADDRESS")}.`,
      ]);
    },
    3 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let withdrawAttestation: RespondBidirectionalEvent;

  it(
    "pollRespondBidirectional: the MPC attests wallet B's transfer as succeeded",
    async () => {
      expect(withdrawRequestId).toBeDefined();

      const context = await bearerSession.vaultContext();
      withdrawAttestation = await pollRespondBidirectional(context, {
        requestId: withdrawRequestId,
        intervalMs: 1000,
        timeoutMs: 3 * MINUTE,
      });

      // The broadcast step saw the transfer mine, so the MPC must attest
      // success (first output byte 1), not its error sentinel.
      expect(
        executionSucceeded(withdrawAttestation.serializedOutput),
        "the MPC must attest wallet B's withdraw transfer as succeeded",
      ).toBe(true);

      banner([
        `Found success attestation for wallet B's withdraw ${withdrawRequestId}.`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "completeWithdraw: wallet B settles its withdrawal — request and refund marker consumed",
    async () => {
      expect(withdrawRequestId).toBeDefined();
      expect(withdrawAttestation).toBeDefined();

      const context = await bearerSession.vaultContext();
      const requestKey = requestIdBytes(withdrawRequestId);
      const readLedger = () => readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

      // Rerun against a kept contract address: if a prior run already settled
      // this request the pending-withdrawal marker is gone and
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
      expect(before.signBidirectionalEventMap.member(requestKey)).toBe(true);

      await completeWithdraw(context, { requestId: withdrawRequestId });

      const after = await readLedger();
      expect(
        after.signBidirectionalEventMap.member(requestKey),
        "completeWithdraw must consume the request from the ledger",
      ).toBe(false);
      expect(
        after.refundCommitment.member(requestKey),
        "completeWithdraw must consume the pending-withdrawal marker",
      ).toBe(false);

      banner([
        `Wallet B's withdraw ${withdrawRequestId} settled (success — no refund).`,
        "",
        "The ownership handoff is proven end to end: value deposited by A,",
        "handed to B in a plain wallet transfer, withdrawn to completion by B —",
        "while A, holding nothing, could not fund a withdraw at all.",
      ]);
    },
    15 * MINUTE,
  );
});
