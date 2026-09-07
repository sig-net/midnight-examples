// The contract-owned EVM nonce, end to end on the Sepolia-forked anvil.
//
// All four vault-signed flows (withdraw, swap, supply, redeem) plus the two
// approves sign from ONE shared EVM account — the vault's, derived at path
// "vault". An EVM account has a single nonce sequence, so when `start*` took
// an evmNonce ARGUMENT two callers could pick the same value: only one of the
// two Ethereum transactions could ever mine, the loser was attested as a
// failure and had to refund. That was an end-to-end throughput bottleneck, not
// just a Midnight-side one. `start*` no longer takes a nonce; the contract's
// own `vaultEvmNonce` counter hands one out per entry `flush` DRAINS.
//
// This file proves the two halves of that design against a real chain:
//
//   TEST A — throughput. Two DIFFERENT callers each queue a withdrawal
//     concurrently, ONE flush drains both, and BOTH signed Ethereum
//     transactions are broadcast and MINE, at distinct contiguous nonces.
//
//   TEST B — the gap, and that it self-heals. Three withdrawals get nonces
//     n, n+1, n+2. Broadcasting n+1 and n+2 while withholding n leaves both
//     STUCK (Ethereum executes an account's transactions in nonce order), and
//     a THIRD PARTY — not the requester, not the flusher — then reconstructs
//     the orphaned transaction n from PUBLIC data alone (the request
//     parameters from the vault contract's own ledger map, the signature from
//     the singleton's SignatureRespondedEvent) and broadcasts it, after which
//     all three mine. That is why the contract may own the counter: it is the
//     only signer of this account, so it knows exactly how many signatures it
//     has issued, and the only failure mode — a signed transaction nobody
//     broadcast — is repairable by anyone.
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialise lives there.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.

import { VAULT_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import { submitTransferTransaction, waitForFacadeState } from "@sig-net/midnight-examples-lib";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  logSkip,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { type RequestIdHex, toSignBidirectionalEventIndex } from "@sig-net/midnight";
import {
  formatEther,
  JsonRpcProvider,
  parseEther,
  parseUnits,
  type Transaction,
  type TransactionReceipt,
} from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { ERC20_TRANSFER_GAS_LIMIT, ERC20_TRANSFER_MAX_FEE_PER_GAS } from "../src/evm-transfer.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import { flushVaultRequests } from "../src/flows/flush.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import {
  predictWithdrawRequestId,
  type QueuedWithdraw,
  queueWithdraw,
} from "../src/flows/start-withdraw.ts";
import { sleepUnlessAborted } from "../src/sleep-unless-aborted.ts";
import { readVaultLedger } from "../src/vault-ledger.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

/** The setup-populated env accumulator; empty when RUN_INTEGRATION_TESTS is unset. */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// One withdrawal's worth. Five are spent here: one by each caller in TEST A,
// three by TEST B.
const UNIT = parseUnits("0.02", 6);
const WITHDRAWALS = 5n;
const DEPOSIT_AMOUNT = UNIT * WITHDRAWALS;

// Caller A: the suite's user wallet + identity.
const session = createVaultSession(env);

// Caller B: the `bearer` role wallet's seed as BOTH wallet seed and identity
// secret, so this is a genuinely different caller — a different
// callerSecretKey witness, hence a different queue key and a different refund
// commitment. Both env vars are overridden together (see bearer-transfer.test.ts
// for why). B SPENDS (it queues its own withdrawal and pays that call's fees),
// which is why it is a setup-funded role wallet rather than a bare seed.
const BEARER_SEED = env.BEARER_SEED ?? "";
const callerBSession = createVaultSession({
  ...env,
  USER_SEED: BEARER_SEED,
  VAULT_USER_SECRET_KEY: BEARER_SEED,
});

// The third party of TEST B: neither requester nor flusher, holding no
// secret of either. A fixed receive-only seed, like the false-claimer's — it
// never submits a Midnight transaction, it only READS the two contracts'
// public state and posts bytes to the EVM chain.
const STRANGER_SEED = "0000000000000000000000000000000000000000000000000000000000000044";
const strangerSession = createVaultSession({
  ...env,
  USER_SEED: STRANGER_SEED,
  VAULT_USER_SECRET_KEY: STRANGER_SEED,
});

/** The vault-token color for the suite's ERC20 on the deployed vault. */
const vaultTokenColor = () =>
  vaultTokenType(requireEnv("ERC20_ADDRESS"), requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"));

/**
 * The vault EVM account's MINED nonce. Deliberately `latest`, not the
 * harness's `pending`: TEST B's whole point is transactions sitting in the
 * pool that have NOT been executed, and only `latest` distinguishes the two.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @param address - The account to read.
 * @returns The number of transactions the account has actually mined.
 */
async function minedNonce(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return BigInt(await provider.getTransactionCount(address, "latest"));
  } finally {
    provider.destroy();
  }
}

/**
 * A signed transaction's hash, which is non-null exactly when it is signed.
 *
 * @param transaction - The signed transaction.
 * @returns Its hash.
 * @throws {Error} If the transaction carries no signature.
 */
const signedHash = (transaction: Transaction): string => {
  if (transaction.hash === null) {
    throw new Error("expected a signed transaction to carry a hash");
  }
  return transaction.hash;
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault EVM-nonce e2e: the contract owns the shared vault account's nonce sequence",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await callerBSession.stop();
      await strangerSession.stop();
    });

    it(
      "preflight: the vault is initialised and its EVM account can pay for five transfers",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(
          state.initialised,
          "vault is not initialised: run tests/happy-day-e2e.test.ts first",
        ).toBe(1n);

        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");

        // The arrange deposit sweeps DEPOSIT_AMOUNT out of the user's derived
        // account, so it must hold that much ERC20 and the sweep's gas.
        const userEth = await getEthBalance(rpcUrl, userAddress);
        expect(userEth, `fund ${userAddress} with >= 0.009 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.009"),
        );
        const { balance: userErc20 } = await getErc20Balance(
          rpcUrl,
          requireEnv("ERC20_ADDRESS"),
          userAddress,
        );
        expect(
          userErc20,
          `fund ${userAddress} with >= ${String(DEPOSIT_AMOUNT)} base units of the ERC20`,
        ).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT);

        // Five MPC-signed transfers leave the VAULT's account, which pays its
        // own gas.
        const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS * WITHDRAWALS;
        const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
        expect(
          vaultEth,
          `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH`,
        ).toBeGreaterThanOrEqual(gasBudget);

        // The invariant the whole design rests on, asserted before anything is
        // queued: the contract's counter IS the account's mined nonce. It can
        // only drift by a signed transaction nobody broadcast — the gap TEST B
        // creates on purpose and then heals.
        const vaultChainNonce = await minedNonce(rpcUrl, vaultAddress);
        expect(
          vaultChainNonce,
          "vaultEvmNonce must match the vault account's mined nonce — an earlier run left a signed vault transaction unbroadcast (see TEST B for the repair)",
        ).toBe(state.vaultEvmNonce);
      },
      5 * MINUTE,
    );

    it(
      "arrange: caller A deposits five units and hands one to caller B",
      async () => {
        const color = vaultTokenColor();
        const walletA = await session.wallet();
        const walletB = await callerBSession.wallet();

        const aBefore = (await walletA.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        const stateB = await walletB.facade.waitForSyncedState();
        const bBefore = stateB.shielded.balances[color] ?? 0n;

        // Rerun tolerance: what this arrange must deliver is A holding four
        // units and B holding one, with the vault's EVM account custodying the
        // matching ERC20. A prior run that already did so makes a fresh deposit
        // pure cost.
        const { balance: vaultErc20 } = await getErc20Balance(
          requireEnv("EVM_RPC_URL"),
          requireEnv("ERC20_ADDRESS"),
          requireEnv("EVM_VAULT_ADDRESS"),
        );
        if (aBefore >= UNIT * 4n && bBefore >= UNIT && vaultErc20 >= DEPOSIT_AMOUNT) {
          logSkip("arrange", "both callers already hold their vault tokens");
          return;
        }

        if (aBefore < DEPOSIT_AMOUNT) {
          const { requestId } = await runDepositRoundTrip(session, {
            amount: DEPOSIT_AMOUNT,
            reuseRequestId: env.EVM_NONCE_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
          });
          banner([
            `Arrange deposit ${requestId} complete — caller A holds ${String(DEPOSIT_AMOUNT)} base units.`,
            "",
            "If a later step dies (e.g. proof-server OOM), resume with",
            `  EVM_NONCE_DEPOSIT_REQUEST_ID=${requestId}`,
          ]);
        }

        if (bBefore < UNIT) {
          // Vault tokens are BEARER assets: a plain wallet-to-wallet transfer
          // makes B a genuine second withdrawer, with no vault involvement.
          await submitTransferTransaction(walletA.facade, walletA.keys, [
            {
              type: "shielded",
              outputs: [{ type: color, receiverAddress: stateB.shielded.address, amount: UNIT }],
            },
          ]);
          await waitForFacadeState(
            walletB.facade,
            (state) => (state.shielded.balances[color] ?? 0n) >= bBefore + UNIT,
          );
        }

        expect(
          (await walletA.facade.waitForSyncedState()).shielded.balances[color] ?? 0n,
          "caller A must hold four units after the handoff",
        ).toBeGreaterThanOrEqual(UNIT * 4n);
        expect(
          (await walletB.facade.waitForSyncedState()).shielded.balances[color] ?? 0n,
          "caller B must hold one unit after the handoff",
        ).toBeGreaterThanOrEqual(UNIT);
      },
      25 * MINUTE,
    );

    it(
      "TEST A: two callers queue concurrently, ONE flush drains both, and BOTH Ethereum transactions mine at distinct contiguous nonces",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const destEvmAddress = requireEnv("EVM_USER_ADDRESS");

        const contextA = await session.vaultContext();
        const contextB = await callerBSession.vaultContext();

        // Neither call supplies an EVM nonce, and neither reads a shared ledger
        // cell: each only appends under a key derived from its own secret. This
        // is the concurrency the change buys — under the old design each caller
        // would have had to guess the vault account's next nonce, both would
        // have guessed the SAME live value, and only one of the two Ethereum
        // transactions could ever have mined.
        const queuedA = await queueWithdraw(contextA, { amount: UNIT, destEvmAddress });
        const queuedB = await queueWithdraw(contextB, { amount: UNIT, destEvmAddress });
        expect(queuedA.queueKey).not.toEqual(queuedB.queueKey);

        // Read both counters between the queue and the drain: slot i of the
        // batch gets request nonce base+i, and — because both slots are live —
        // EVM nonce evmBase+i.
        const beforeFlush = await readVaultLedger(
          contextA.providers.publicDataProvider,
          contextA.vaultContractAddress,
        );
        const evmBase = beforeFlush.vaultEvmNonce;
        expect(await minedNonce(rpcUrl, vaultAddress)).toBe(evmBase);

        const idA = predictWithdrawRequestId(
          contextA,
          beforeFlush,
          queuedA,
          beforeFlush.signetRequestNonce,
          evmBase,
        );
        const idB = predictWithdrawRequestId(
          contextA,
          beforeFlush,
          queuedB,
          beforeFlush.signetRequestNonce + 1n,
          evmBase + 1n,
        );

        // ONE flush, drained by caller A on behalf of both. flush is
        // permissionless and reads no secret; A gains no claim on B's refund.
        await flushVaultRequests(contextA, [queuedA.queueKey, queuedB.queueKey]);

        const afterFlush = await readVaultLedger(
          contextA.providers.publicDataProvider,
          contextA.vaultContractAddress,
        );
        const index = toSignBidirectionalEventIndex(afterFlush.signBidirectionalEventMap);
        const recordA = index.get(idA);
        const recordB = index.get(idB);
        expect(recordA, `flush did not record caller A's request ${idA}`).toBeDefined();
        expect(recordB, `flush did not record caller B's request ${idB}`).toBeDefined();
        expect(recordA?.txParams.nonce).toBe(evmBase);
        expect(recordB?.txParams.nonce).toBe(evmBase + 1n);
        // Both slots were live, so the counter advanced by exactly two.
        expect(afterFlush.vaultEvmNonce).toBe(evmBase + 2n);
        // And B's settle view still names B, not the flusher.
        expect(afterFlush.withdrawSettleViews.size()).toBeGreaterThanOrEqual(2n);

        // The MPC signs both with the VAULT's account.
        const signedA = await pollSignatureResponse(contextA, {
          requestId: idA,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: vaultAddress,
          requestsPath: VAULT_REQUESTS_PATH,
        });
        const signedB = await pollSignatureResponse(contextB, {
          requestId: idB,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: vaultAddress,
          requestsPath: VAULT_REQUESTS_PATH,
        });
        expect(BigInt(signedA.nonce)).toBe(evmBase);
        expect(BigInt(signedB.nonce)).toBe(evmBase + 1n);
        expect(signedA.from?.toLowerCase()).toBe(vaultAddress.toLowerCase());
        expect(signedB.from?.toLowerCase()).toBe(vaultAddress.toLowerCase());

        // The assertion that matters: BOTH mine. Broadcast in nonce order,
        // exactly as a client must.
        const receiptA = await broadcastEvm(contextA, { transaction: signedA });
        const receiptB = await broadcastEvm(contextA, { transaction: signedB });
        expect(receiptA.status).toBe(1);
        expect(receiptB.status).toBe(1);
        expect(await minedNonce(rpcUrl, vaultAddress)).toBe(evmBase + 2n);

        banner([
          "Two callers, one flush, two mined Ethereum transactions:",
          "",
          `  caller A: request ${idA} at vault nonce ${String(evmBase)}`,
          `  caller B: request ${idB} at vault nonce ${String(evmBase + 1n)}`,
          "",
          "Under the caller-supplied-evmNonce design both would have carried the",
          "same nonce and only one could ever have mined.",
        ]);
      },
      25 * MINUTE,
    );

    it(
      "TEST B: a withheld transaction stalls the two behind it, and ANY third party can clear the gap from public data",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const destEvmAddress = requireEnv("EVM_USER_ADDRESS");
        const contextA = await session.vaultContext();

        // Three withdrawals, queued without any nonce.
        const queueOne = (): Promise<QueuedWithdraw> =>
          queueWithdraw(contextA, { amount: UNIT, destEvmAddress });
        const queued1 = await queueOne();
        const queued2 = await queueOne();
        const queued3 = await queueOne();

        // Two flush calls, because the contract's batch width is two. The EVM
        // nonces must still come out CONTIGUOUS across the batch boundary: the
        // counter advances by entries drained, not by batch width.
        const before1 = await readVaultLedger(
          contextA.providers.publicDataProvider,
          contextA.vaultContractAddress,
        );
        const evmBase = before1.vaultEvmNonce;
        expect(await minedNonce(rpcUrl, vaultAddress)).toBe(evmBase);
        const id1 = predictWithdrawRequestId(
          contextA,
          before1,
          queued1,
          before1.signetRequestNonce,
          evmBase,
        );
        const id2 = predictWithdrawRequestId(
          contextA,
          before1,
          queued2,
          before1.signetRequestNonce + 1n,
          evmBase + 1n,
        );
        await flushVaultRequests(contextA, [queued1.queueKey, queued2.queueKey]);

        const before2 = await readVaultLedger(
          contextA.providers.publicDataProvider,
          contextA.vaultContractAddress,
        );
        expect(before2.vaultEvmNonce).toBe(evmBase + 2n);
        const id3 = predictWithdrawRequestId(
          contextA,
          before2,
          queued3,
          before2.signetRequestNonce,
          evmBase + 2n,
        );
        await flushVaultRequests(contextA, [queued3.queueKey]);

        const afterFlush = await readVaultLedger(
          contextA.providers.publicDataProvider,
          contextA.vaultContractAddress,
        );
        const index = toSignBidirectionalEventIndex(afterFlush.signBidirectionalEventMap);
        expect([id1, id2, id3].map((id) => index.get(id)?.txParams.nonce)).toEqual([
          evmBase,
          evmBase + 1n,
          evmBase + 2n,
        ]);
        expect(afterFlush.vaultEvmNonce).toBe(evmBase + 3n);

        // Fetch the SECOND and THIRD signatures only. The first is deliberately
        // never touched here: the requester behaves exactly like a client whose
        // transaction was signed and then lost.
        const signed2 = await pollSignatureResponse(contextA, {
          requestId: id2,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: vaultAddress,
          requestsPath: VAULT_REQUESTS_PATH,
        });
        const signed3 = await pollSignatureResponse(contextA, {
          requestId: id3,
          intervalMs: 1000,
          timeoutMs: 3 * MINUTE,
          expectedSigner: vaultAddress,
          requestsPath: VAULT_REQUESTS_PATH,
        });

        // 1. Broadcast n+1 and n+2, withholding n. Raw provider calls, not
        //    broadcastEvm: broadcastEvm waits for a confirmation that must not
        //    come.
        const provider = new JsonRpcProvider(rpcUrl);
        try {
          await provider.broadcastTransaction(signed2.serialized);
          await provider.broadcastTransaction(signed3.serialized);

          // 2. Neither may mine: Ethereum executes an account's transactions in
          //    nonce order, so both sit behind the hole at `evmBase`. Anvil
          //    automines, so a few seconds is generous.
          await sleepUnlessAborted(5000);
          expect(
            await provider.getTransactionReceipt(signedHash(signed2)),
            "the transaction at nonce n+1 must NOT mine while n is missing",
          ).toBeNull();
          expect(
            await provider.getTransactionReceipt(signedHash(signed3)),
            "the transaction at nonce n+2 must NOT mine while n is missing",
          ).toBeNull();
          expect(
            await minedNonce(rpcUrl, vaultAddress),
            "the vault account's mined nonce must not have advanced",
          ).toBe(evmBase);

          banner([
            `Gap created on purpose: vault nonce ${String(evmBase)} withheld.`,
            "",
            `  nonce ${String(evmBase + 1n)}: broadcast, stuck`,
            `  nonce ${String(evmBase + 2n)}: broadcast, stuck`,
          ]);

          // 3. The repair, by a THIRD PARTY. The stranger holds no secret of
          //    the requester's and did not flush. Everything it needs is
          //    public: `pollSignatureResponse` reads the request parameters out
          //    of the VAULT CONTRACT's own ledger map (at VAULT_REQUESTS_PATH)
          //    and the signature out of the singleton's SignatureRespondedEvent,
          //    then reassembles the signed transaction. No trust in the flusher
          //    or the original requester is required for a gap to clear.
          const strangerContext = await strangerSession.vaultContext();
          expect(strangerContext.identity.commitmentHex).not.toBe(contextA.identity.commitmentHex);
          const orphan = await pollSignatureResponse(strangerContext, {
            requestId: id1,
            intervalMs: 1000,
            timeoutMs: 3 * MINUTE,
            expectedSigner: vaultAddress,
            requestsPath: VAULT_REQUESTS_PATH,
          });
          expect(BigInt(orphan.nonce)).toBe(evmBase);
          expect(orphan.from?.toLowerCase()).toBe(vaultAddress.toLowerCase());
          const orphanReceipt = await broadcastEvm(strangerContext, { transaction: orphan });
          expect(orphanReceipt.status).toBe(1);

          // 4. All three mined, in nonce order, and the account advanced by
          //    three. broadcastEvm is idempotent, so these two just wait on the
          //    transactions the node already holds.
          const receipt2 = await broadcastEvm(contextA, { transaction: signed2 });
          const receipt3 = await broadcastEvm(contextA, { transaction: signed3 });
          expect(receipt2.status).toBe(1);
          expect(receipt3.status).toBe(1);
          expect(await minedNonce(rpcUrl, vaultAddress)).toBe(evmBase + 3n);

          // Nonce order IS inclusion order: an account's transactions can only
          // execute in nonce sequence, so each receipt must sit strictly after
          // the previous one in (block, index).
          const position = (receipt: TransactionReceipt): number =>
            receipt.blockNumber * 1_000_000 + receipt.index;
          expect(
            position(receipt2) > position(orphanReceipt),
            `nonce ${String(evmBase + 1n)} mined before nonce ${String(evmBase)}`,
          ).toBe(true);
          expect(
            position(receipt3) > position(receipt2),
            `nonce ${String(evmBase + 2n)} mined before nonce ${String(evmBase + 1n)}`,
          ).toBe(true);

          banner([
            "Gap cleared by a third party, from public data alone:",
            "",
            `  nonce ${String(evmBase)}:     reconstructed + broadcast by the stranger`,
            `  nonce ${String(evmBase + 1n)}: mined behind it`,
            `  nonce ${String(evmBase + 2n)}: mined behind it`,
          ]);
        } finally {
          provider.destroy();
        }
      },
      25 * MINUTE,
    );
  },
);
