// The break-glass e2e: `adminReplaceEvmNonce` unblocks a stalled vault nonce
// sequence.
//
// The vault signs every transaction it originates from ONE EVM account with a
// strictly sequential nonce. A transaction that can never be included —
// classically one whose baked-in `maxFeePerGas` sits below the base fee —
// therefore blocks every transaction queued behind it, and raising the ceiling
// with `setGasParams` does not rescue it: the old ceiling is inside the bytes
// the MPC already signed. The remedy is replacement, and its minimal form is
// an empty self-transfer at the same nonce.
//
// This spec reproduces the outage and the fix on the fork: it strands nonce n
// behind a signed-but-unbroadcast transaction, shows a transaction at n+1
// cannot mine, then breaks the glass at n and shows both mine.
//
// Every claim here is asserted against real receipts and the account's
// on-chain nonce, never local bookkeeping.
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { getAddress, JsonRpcProvider, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { adminReplaceEvmNonce } from "../src/flows/admin-replace-evm-nonce.ts";
import { approveRouter } from "../src/flows/approve-router.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { initialise } from "../src/flows/initialise.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { createVaultSession } from "../src/vault-session.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);

const MINUTE = 60_000;

/** The exact gas an EVM value transfer with no calldata costs. */
const REPLACEMENT_GAS_LIMIT = 21_000n;

/**
 * How long the queued transaction is watched before its non-inclusion counts
 * as the stall. The chain auto-mines on every transaction it accepts, so a
 * transaction that is going to mine has done so long before this elapses.
 */
const STALL_OBSERVATION_MS = 15_000;

/** A signed transaction's hash, which is only null while it is unsigned. */
const signedHash = (transaction: Transaction, what: string): string => {
  const { hash } = transaction;
  if (hash === null) throw new Error(`${what} is unsigned, so it has no hash`);
  return hash;
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault admin-replace-nonce e2e", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });

  it(
    "replaces a stuck nonce with an empty self-transfer and the queue behind it mines",
    async () => {
      const context = await session.vaultContext();

      // Seal the config before any flow. A kept contract address that is
      // already initialised is left untouched.
      await initialise(context, resolveInitialiseConfig(env, context.vaultContractAddress));

      const provider = new JsonRpcProvider(context.evmRpcUrl);
      // MINED nonce, deliberately: the "pending" count would fold in the very
      // transactions whose non-inclusion this test is about.
      const minedNonce = (): Promise<number> =>
        provider.getTransactionCount(context.evmVaultAddress, "latest");

      // 1. n — the vault account's next nonce on chain.
      const n = await minedNonce();

      // 2. A real vault-signed request takes nonce n and is signed, then
      //    deliberately NOT broadcast. That is the outage in miniature: nonce
      //    n is spoken for by a transaction nothing can include, and it cannot
      //    be re-signed at another nonce because the signature covers it.
      const blockingId = await approveRouter(context, BigInt(n));
      const blocking = await pollSignatureResponse(context, {
        requestId: blockingId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });
      expect(blocking.nonce).toBe(n);

      // 3. The next request, at n+1, IS broadcast. EVM nonces are strictly
      //    sequential, so the node can only queue it behind the empty slot.
      const queuedId = await approveRouter(context, BigInt(n + 1));
      const queued = await pollSignatureResponse(context, {
        requestId: queuedId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });
      expect(queued.nonce).toBe(n + 1);
      const queuedHash = signedHash(queued, "the queued transaction");
      await provider.broadcastTransaction(queued.serialized);

      // The stall itself, asserted before anything is claimed about it: the
      // broadcast transaction has no receipt and the account has not moved.
      await new Promise((resolve) => setTimeout(resolve, STALL_OBSERVATION_MS));
      expect(await provider.getTransactionReceipt(queuedHash)).toBeNull();
      expect(await minedNonce()).toBe(n);

      // 4. Break the glass at n. Fees come from the ledger, so a real outage
      //    raises them with setGasParams first; here nothing is competing for
      //    the slot, so initialise's defaults already outbid the nothing that
      //    was ever broadcast.
      const replacementId = await adminReplaceEvmNonce(context, BigInt(n));
      const replacement = await pollSignatureResponse(context, {
        requestId: replacementId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });

      // The transaction the MPC actually signed is the empty self-transfer.
      expect({
        nonce: replacement.nonce,
        to: replacement.to,
        value: replacement.value,
        data: replacement.data,
        gasLimit: replacement.gasLimit,
      }).toEqual({
        nonce: n,
        to: getAddress(context.evmVaultAddress),
        value: 0n,
        data: "0x",
        gasLimit: REPLACEMENT_GAS_LIMIT,
      });

      // 5. Broadcasting it consumes the blocked nonce…
      const replacementReceipt = await broadcastEvm(context, { transaction: replacement });
      expect(replacementReceipt.status).toBe(1);

      // …and the transaction that was queued behind it mines on its own, with
      // no further help. That is the queue moving again.
      const queuedReceipt = await provider.waitForTransaction(queuedHash, 1, 5 * MINUTE);
      expect(queuedReceipt?.status).toBe(1);

      // Two nonces consumed: the replacement at n, the queued approve at n+1.
      // The blocking transaction at n is CANCELLED, not retried — its request
      // record stays on the ledger unsettled and its approve never happens.
      expect(await minedNonce()).toBe(n + 2);

      console.log(
        `ADMIN REPLACE NONCE E2E OK: nonce ${String(n)} replaced with an empty self-transfer ` +
          `(${signedHash(replacement, "the replacement")}), queued tx ${queuedHash} then mined; ` +
          `account nonce ${String(n)} -> ${String(n + 2)}`,
      );
    },
    30 * MINUTE,
  );
});
