// The nonce replacement e2e flow: a withdrawal the MPC signs but nobody broadcasts
// leaves the vault's EVM account stuck at its nonce. The deployer replaces that
// nonce with a zero-value self-transfer, which mines and settles through
// `completeReplaceNonce`, and the MPC attests the replaced withdrawal unviable at
// the replacement's block, so `completeWithdraw`'s failure branch re-mints the
// burned shielded vault tokens.
//
// The unviable attestation needs an ARCHIVE Sepolia RPC behind the anvil fork: the
// fakenet responder finds the block that consumed the replaced nonce by bisecting
// the account's nonce over chain history. The replacement's executed attestation
// carries the success value the MPC synthesises for a plain transfer, which returns
// no data: the poll recomputes it from the respond schema (see completeReplaceNonce).
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there, and
// the session's identity must be the deployer's (the setup defaults
// VAULT_DEPLOYER_SECRET_KEY to it). Recovery from a run that died mid-flow: rerun
// this file with REPLACE_NONCE_DEPOSIT_REQUEST_ID, REPLACE_NONCE_WITHDRAW_REQUEST_ID
// and REPLACE_NONCE_REPLACEMENT_REQUEST_ID set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the example's typed flow functions (src/flows/),
// in-process, never a subprocess.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  Action,
  readVaultLedger,
  VAULT_REPLACE_NONCE_REQUESTS_PATH,
  VAULT_WITHDRAW_REQUESTS_PATH,
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
import {
  formatEther,
  getAddress,
  JsonRpcProvider,
  parseEther,
  parseUnits,
  type Transaction,
  type TransactionReceipt,
} from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleReplaceNonce } from "../src/flows/complete-replace-nonce.ts";
import { settleWithdraw } from "../src/flows/complete-withdraw.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startReplaceNonce } from "../src/flows/start-replace-nonce.ts";
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

// The gas limit startReplaceNonce fixes: the intrinsic gas of a plain transfer.
const REPLACEMENT_GAS_LIMIT = 21_000n;

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

// One deposit's worth of shielded vault tokens is arranged, burned by the
// replaced withdraw, and re-minted: 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

/**
 * The vault account's mined transaction count: the nonce of its next
 * transaction to mine.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param address - The vault's derived EVM account.
 * @returns The count at the latest block.
 */
async function minedNonce(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return BigInt(await provider.getTransactionCount(address, "latest"));
  } finally {
    provider.destroy();
  }
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault withdraw → nonce replacement → refund e2e",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: user EVM account holds the deposit minimums, vault EVM account holds the replacement gas budget",
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

        // The replacement is the only vault-signed transaction this spec mines:
        // require its fee cap at the vault's fee settings.
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const gasBudget = REPLACEMENT_GAS_LIMIT * state.vaultMaxFeePerGas;
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
      "arrange: deposit round trip mints the shielded vault tokens the replaced withdraw will burn",
      async () => {
        const { requestId } = await runDepositRoundTrip(session, {
          amount: DEPOSIT_AMOUNT,
          reuseRequestId: env.REPLACE_NONCE_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete: the caller holds ${String(DEPOSIT_AMOUNT)} base units of shielded vault tokens.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  REPLACE_NONCE_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    // Populated by the withdraw leg (or REPLACE_NONCE_WITHDRAW_REQUEST_ID) for the
    // subsequent stages.
    let withdrawRequestId: RequestIdHex;

    it(
      "withdraw: burn shielded vault tokens for a transfer that will never be broadcast",
      async () => {
        if (env.REPLACE_NONCE_WITHDRAW_REQUEST_ID) {
          withdrawRequestId = env.REPLACE_NONCE_WITHDRAW_REQUEST_ID as RequestIdHex;
          logSkip(
            "withdraw",
            `REPLACE_NONCE_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        withdrawRequestId = await startWithdraw(context, {
          amount: WITHDRAW_AMOUNT,
          destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
        });
        expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Withdraw request recorded on the vault ledger:`,
          "",
          `  request id: ${withdrawRequestId}`,
          "",
          "The caller's shielded vault tokens are burned. If a later step dies,",
          `resume with REPLACE_NONCE_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below: the vault nonce the replacement takes.
    let withdrawNonce: bigint;

    it(
      "pollSignatureResponse: the MPC signs the withdrawal, which stays unbroadcast",
      async () => {
        expect(withdrawRequestId).toBeDefined();

        const context = await session.vaultContext();
        const signedWithdraw = await pollSignatureResponse(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });
        withdrawNonce = BigInt(signedWithdraw.nonce);

        // Nothing ever broadcasts the signed withdrawal: it is the stuck
        // transaction the replacement takes the nonce of.
        const provider = new JsonRpcProvider(context.evmRpcUrl);
        try {
          expect(await provider.getTransactionReceipt(signedTxHash(signedWithdraw))).toBeNull();
        } finally {
          provider.destroy();
        }

        banner([
          `MPC signed withdraw ${withdrawRequestId} at vault nonce ${String(withdrawNonce)}.`,
          "",
          `Signed tx hash: ${signedTxHash(signedWithdraw)} (never broadcast)`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    // Populated by the replacement leg (or REPLACE_NONCE_REPLACEMENT_REQUEST_ID)
    // for the subsequent stages.
    let replacementRequestId: RequestIdHex;

    it(
      "startReplaceNonce: the vault account is stuck at the withdrawal's nonce, and the deployer replaces it",
      async () => {
        expect(withdrawNonce).toBeDefined();
        if (env.REPLACE_NONCE_REPLACEMENT_REQUEST_ID) {
          replacementRequestId = env.REPLACE_NONCE_REPLACEMENT_REQUEST_ID as RequestIdHex;
          logSkip(
            "startReplaceNonce",
            `REPLACE_NONCE_REPLACEMENT_REQUEST_ID present, resuming replacement '${replacementRequestId}'`,
          );
          return;
        }

        const context = await session.vaultContext();
        expect(
          await minedNonce(context.evmRpcUrl, context.evmVaultAddress),
          "the withdrawal must hold the vault account's next nonce, or the replacement unsticks nothing",
        ).toBe(withdrawNonce);
        replacementRequestId = await startReplaceNonce(context, {
          requestId: withdrawRequestId,
          action: Action.withdraw,
        });
        expect(replacementRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          `Replacement of vault nonce ${String(withdrawNonce)} recorded on the vault ledger:`,
          "",
          `  request id: ${replacementRequestId}`,
          "",
          `If a later step dies, resume with REPLACE_NONCE_REPLACEMENT_REQUEST_ID=${replacementRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedReplacement: Transaction;

    it(
      "pollSignatureResponse: the MPC signs an empty 21000-gas self-transfer at the withdrawal's nonce",
      async () => {
        expect(replacementRequestId).toBeDefined();

        const context = await session.vaultContext();
        signedReplacement = await pollSignatureResponse(context, {
          requestId: replacementRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_REPLACE_NONCE_REQUESTS_PATH,
        });

        expect({
          nonce: BigInt(signedReplacement.nonce),
          to: signedReplacement.to,
          value: signedReplacement.value,
          data: signedReplacement.data,
          gasLimit: signedReplacement.gasLimit,
        }).toEqual({
          nonce: withdrawNonce,
          to: getAddress(context.evmVaultAddress),
          value: 0n,
          data: "0x",
          gasLimit: REPLACEMENT_GAS_LIMIT,
        });
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    // Populated by the broadcast step: the block the replaced withdrawal's
    // unviable attestation must name.
    let replacementReceipt: TransactionReceipt;

    it(
      "broadcast the replacement: it mines, and the vault account's nonce catches up with the contract's",
      async () => {
        expect(signedReplacement).toBeDefined();
        const context = await session.vaultContext();

        replacementReceipt = await broadcastEvm(context, { transaction: signedReplacement });
        expect(replacementReceipt.status).toBe(1);

        // Every nonce the flush assigned has now been consumed on chain, so the
        // next vault request mines.
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(await minedNonce(context.evmRpcUrl, context.evmVaultAddress)).toBe(
          state.vaultAccountNonce,
        );

        banner([
          `Replacement ${signedTxHash(signedReplacement)} mined at block ${String(replacementReceipt.blockNumber)}.`,
        ]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let replacementAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests the self-transfer as executed",
      async () => {
        expect(replacementRequestId).toBeDefined();

        const context = await session.vaultContext();
        replacementAttestation = await pollRespondBidirectional(context, {
          requestId: replacementRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_REPLACE_NONCE_REQUESTS_PATH,
        });

        expect(replacementAttestation.event.outputKind).toBe(OutputKind.executed);
        expect(
          replacementAttestation.succeeded,
          "a plain transfer attests the schema's synthesised success value",
        ).toBe(true);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeReplaceNonce: the executed attestation closes the replacement",
      async () => {
        expect(replacementAttestation).toBeDefined();

        const context = await session.vaultContext();
        const requestIndex = requestIdBytes(replacementRequestId);
        const isRequestOnLedger = async () =>
          (
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            )
          ).bidirectionalReplaceNonceMap.member(requestIndex);

        if (!(await isRequestOnLedger())) {
          logSkip(
            "completeReplaceNonce",
            `replacement ${replacementRequestId} already settled (not on the ledger)`,
          );
          return;
        }

        await settleReplaceNonce(context, replacementAttestation);

        expect(
          await isRequestOnLedger(),
          "completeReplaceNonce must consume the request from the ledger",
        ).toBe(false);
      },
      15 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let withdrawAttestation: RespondOutcome;

    it(
      "pollRespondBidirectional: the MPC attests the replaced withdrawal as UNVIABLE at the replacement's block",
      async () => {
        expect(withdrawRequestId).toBeDefined();
        expect(replacementReceipt).toBeDefined();

        const context = await session.vaultContext();
        withdrawAttestation = await pollRespondBidirectional(context, {
          requestId: withdrawRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
        });

        expect(withdrawAttestation.event.outputKind).toBe(OutputKind.unviable);
        expect(withdrawAttestation.event.blockHeight).toBe(BigInt(replacementReceipt.blockNumber));
        expect(withdrawAttestation.serializedOutput, "an unviable output is empty").toHaveLength(0);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeWithdraw: the unviable attestation re-mints the burned tokens and consumes the request",
      async () => {
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
        const reminted = await waitForFacadeState(
          wallet.facade,
          (state) => (state.shielded.balances[color] ?? 0n) >= balanceBefore + WITHDRAW_AMOUNT,
        );
        expect(reminted.shielded.balances[color] ?? 0n).toBe(balanceBefore + WITHDRAW_AMOUNT);

        banner([
          `Withdraw ${withdrawRequestId} settled with a RE-MINT after its nonce was replaced.`,
        ]);
      },
      15 * MINUTE,
    );
  },
);
