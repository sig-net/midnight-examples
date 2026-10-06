// The approve e2e flow: the vault's own EVM account grants its two contract-fixed
// spenders an unlimited allowance, the Uniswap router on the suite's ERC20 (which a
// swap out of that token needs) and the stataToken wrapper on its underlying (which a
// supply needs). Each approval runs the six steps: the deployer starts it, a flush
// assigns the vault nonce, the send records it for the MPC, then the MPC's
// attestation is queued, flushed and settled by `completeApprove`, which closes the
// request and mints nothing. The spec ends each approval by reading the allowance on
// the EVM side.
//
// The starts are deployer-gated: the suite's user identity is the deployer (the
// setup defaults VAULT_DEPLOYER_SECRET_KEY to it). Run AFTER
// tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there. Recovery from a
// run that died mid-flow (proof-server OOM): rerun this file with
// APPROVE_ROUTER_REQUEST_ID / APPROVE_STATA_REQUEST_ID set to the ids the failed run
// printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { bytesToHex, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  readVaultLedger,
  VAULT_APPROVE_REQUESTS_PATH,
  vaultGasEnvelope,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  banner,
  type ContractReadMethod,
  getEthBalance,
  logSkip,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { ethers, formatEther, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleApprove } from "../src/flows/complete-approve.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startApproveRouter, startApproveStata } from "../src/flows/start-approve.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import type { VaultContext } from "../src/vault-context.ts";
import { createVaultSession } from "../src/vault-session.ts";

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

// The deployer's session: wallet facade + vault context shared by every test in
// this file (lazily built, so the offline path never touches the network),
// stopped once in afterAll.
const session = createVaultSession(env);

/** The ERC20 an approval is sent to and the spender it grants, as 0x hex. */
interface Allowance {
  readonly token: string;
  readonly spender: string;
}

/** One approval the spec runs through the six steps. */
interface ApprovalStage {
  /** The approval, as the stage names read. */
  readonly name: string;
  /** The env variable that resumes this approval's open request. */
  readonly resumeVariable: string;
  /** Start, flush and send the approval, returning its request id. */
  readonly start: (context: VaultContext) => Promise<RequestIdHex>;
  /** The allowance the approval grants, from the suite's ERC20 and the ledger's pins. */
  readonly allowance: (context: VaultContext, state: VaultLedgerState) => Allowance;
}

const APPROVAL_STAGES: readonly ApprovalStage[] = [
  {
    name: "router approval",
    resumeVariable: "APPROVE_ROUTER_REQUEST_ID",
    start: (context) => startApproveRouter(context, { erc20Address: context.erc20Address }),
    allowance: (context, state) => ({
      token: context.erc20Address,
      spender: `0x${bytesToHex(state.uniswapRouter)}`,
    }),
  },
  {
    name: "stata approval",
    resumeVariable: "APPROVE_STATA_REQUEST_ID",
    start: (context) => startApproveStata(context),
    allowance: (_context, state) => ({
      token: `0x${bytesToHex(state.stataUnderlying)}`,
      spender: `0x${bytesToHex(state.stataToken)}`,
    }),
  },
];

/**
 * Read an ERC20 allowance on the EVM side.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param owner - The account that granted the allowance.
 * @param allowance - The ERC20 and the spender.
 * @returns What `spender` may still spend of `owner`'s balance.
 */
const erc20Allowance = (rpcUrl: string, owner: string, allowance: Allowance): Promise<bigint> =>
  new ethers.Contract(
    allowance.token,
    ["function allowance(address,address) view returns (uint256)"],
    new ethers.JsonRpcProvider(rpcUrl),
  ).getFunction<ContractReadMethod<bigint>>("allowance")(owner, allowance.spender);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault approve e2e: the vault account approves the router and stataToken",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: vault EVM account holds the gas budget of both approvals",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");

        // Both approve transactions are sent FROM the vault's derived account,
        // which pays its own gas at the vault's approve gas settings.
        const context = await session.vaultContext();
        const { gasLimit, maxFeePerGas } = vaultGasEnvelope(
          await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
          "approve",
        );
        const gasBudget = BigInt(APPROVAL_STAGES.length) * gasLimit * maxFeePerGas;
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

    describe.each(APPROVAL_STAGES)("$name", ({ name, resumeVariable, start, allowance }) => {
      // Populated by the start stage (or the resume variable) for the later stages.
      let requestId: RequestIdHex;

      it(
        `start: the deployer queues the ${name}, a flush assigns its vault nonce, and it is sent`,
        async () => {
          const resumeId = env[resumeVariable];
          if (resumeId) {
            requestId = resumeId as RequestIdHex;
            logSkip(name, `${resumeVariable} present, resuming request '${requestId}'`);
            return;
          }

          const context = await session.vaultContext();
          requestId = await start(context);
          expect(requestId).toMatch(/^[0-9a-f]{64}$/);

          banner([
            `The ${name} is recorded on the vault ledger:`,
            "",
            `  request id: ${requestId}`,
            "",
            "If a later step dies, resume with",
            `  ${resumeVariable}=${requestId}`,
          ]);
        },
        15 * MINUTE,
      );

      // Populated by the poll step below for the broadcast step.
      let signedTransaction: Transaction;

      it(
        `pollSignatureResponse: the MPC signs the ${name} with the vault's account`,
        async () => {
          expect(requestId).toBeDefined();

          const context = await session.vaultContext();
          signedTransaction = await pollSignatureResponse(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
            expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
            requestsPath: VAULT_APPROVE_REQUESTS_PATH,
          });

          banner([
            `MPC signed response for the ${name} ${requestId} found from Signet Contract.`,
            "",
            `Signed tx hash: ${signedTxHash(signedTransaction)}`,
          ]);
        },
        POLL_TIMEOUT_MS + 5 * MINUTE,
      );

      it(
        `broadcast approve evm txn: the ${name} mines on the EVM side`,
        async () => {
          expect(signedTransaction).toBeDefined();
          const context = await session.vaultContext();

          // broadcastEvm waits for one confirmation and throws if the tx
          // reverted. An already-mined tx (rerun) short-circuits.
          const receipt = await broadcastEvm(context, { transaction: signedTransaction });

          banner([`The ${name} mined on EVM: ${receipt.hash}`]);
        },
        3 * MINUTE,
      );

      // Populated by the poll step below for the settle step.
      let attestation: RespondOutcome;

      it(
        `pollRespondBidirectional: the MPC attests the ${name} as succeeded`,
        async () => {
          expect(requestId).toBeDefined();

          const context = await session.vaultContext();
          attestation = await pollRespondBidirectional(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
            requestsPath: VAULT_APPROVE_REQUESTS_PATH,
          });

          // The broadcast step saw the approve mine, so the MPC must attest
          // success (approve's bool true), not a failure kind.
          expect(attestation.succeeded, `the MPC must attest the ${name} as succeeded`).toBe(true);

          banner([`Found success attestation for the ${name} ${requestId}.`]);
        },
        POLL_TIMEOUT_MS + 5 * MINUTE,
      );

      it(
        `completeApprove: the deployer settles the ${name} and the request is consumed`,
        async () => {
          expect(requestId).toBeDefined();
          expect(attestation).toBeDefined();

          const context = await session.vaultContext();
          const isRequestOnLedger = async () =>
            (
              await readVaultLedger(
                context.providers.publicDataProvider,
                context.vaultContractAddress,
              )
            ).bidirectionalApproveMap.member(requestIdBytes(requestId));

          // Rerun against a kept contract address: if a prior run already settled
          // this request the entry is gone and completeApprove would reject with
          // "Request not sent", so skip cleanly instead.
          if (!(await isRequestOnLedger())) {
            logSkip("completeApprove", `${name} ${requestId} already settled (not on the ledger)`);
            return;
          }

          await settleApprove(context, attestation);

          expect(
            await isRequestOnLedger(),
            "completeApprove must consume the request from the ledger",
          ).toBe(false);

          banner([`The ${name} ${requestId} settled (closed, nothing minted).`]);
        },
        15 * MINUTE,
      );

      it(
        `allowance: the vault account grants the ${name}'s spender unlimitedAllowance()`,
        async () => {
          const context = await session.vaultContext();
          const granted = allowance(
            context,
            await readVaultLedger(
              context.providers.publicDataProvider,
              context.vaultContractAddress,
            ),
          );

          const onChain = await erc20Allowance(
            requireEnv("EVM_RPC_URL"),
            requireEnv("EVM_VAULT_ADDRESS"),
            granted,
          );

          expect(onChain).toBe(pureCircuits.unlimitedAllowance());
          banner([
            `The vault account's allowance for ${granted.spender} on ${granted.token}:`,
            "",
            `  ${String(onChain)} (unlimitedAllowance())`,
          ]);
        },
        5 * MINUTE,
      );
    });
  },
);
