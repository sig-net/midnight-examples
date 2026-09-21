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

const REPLACEMENT_GAS_LIMIT = 21_000n;

const STALL_OBSERVATION_MS = 15_000;

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

      await initialise(context, await resolveInitialiseConfig(env, context.vaultContractAddress));

      const provider = new JsonRpcProvider(context.evmRpcUrl);
      const minedNonce = (): Promise<number> =>
        provider.getTransactionCount(context.evmVaultAddress, "latest");

      const n = await minedNonce();

      const blockingId = await approveRouter(context);
      const blocking = await pollSignatureResponse(context, {
        requestId: blockingId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });
      expect(blocking.nonce).toBe(n);

      const queuedId = await approveRouter(context);
      const queued = await pollSignatureResponse(context, {
        requestId: queuedId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });
      expect(queued.nonce).toBe(n + 1);
      const queuedHash = signedHash(queued, "the queued transaction");
      await provider.broadcastTransaction(queued.serialized);

      await new Promise((resolve) => setTimeout(resolve, STALL_OBSERVATION_MS));
      expect(await provider.getTransactionReceipt(queuedHash)).toBeNull();
      expect(await minedNonce()).toBe(n);

      const replacementId = await adminReplaceEvmNonce(context, BigInt(n));
      const replacement = await pollSignatureResponse(context, {
        requestId: replacementId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: context.evmVaultAddress,
      });

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

      const replacementReceipt = await broadcastEvm(context, { transaction: replacement });
      expect(replacementReceipt.status).toBe(1);

      const queuedReceipt = await provider.waitForTransaction(queuedHash, 1, 5 * MINUTE);
      expect(queuedReceipt?.status).toBe(1);

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
