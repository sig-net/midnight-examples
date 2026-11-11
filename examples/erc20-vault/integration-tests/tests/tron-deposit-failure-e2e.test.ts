import { requestIdBytes, type RequestIdHex, tronAddressFromEvm } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { banner } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { broadcastTron } from "../src/flows/broadcast-tron.ts";
import { settleTronDeposit } from "../src/flows/complete-tron-deposit.ts";
import { pollTronRespondBidirectional } from "../src/flows/poll-tron-respond-bidirectional.ts";
import { pollTronSignedTransaction } from "../src/flows/poll-tron-signature-response.ts";
import { startTronDeposit } from "../src/flows/start-tron-deposit.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { withTronBlockPusher } from "../src/tron-block-pusher.ts";
import { createTronContext } from "../src/tron-context.ts";
import { getTrc20Balance } from "../src/tron-http.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron deposit failure e2e: a reverted transfer closes the request with no mint",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "a deposit of more than the account holds reverts on Tron, is attested failed, and closes without minting",
      async () => {
        const context = await session.vaultContext();
        const tron = await createTronContext(env);
        const token = tronAddressFromEvm(tron.trc20Address);

        let requestId = env.TRON_FAILURE_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
        if (requestId === undefined) {
          const held = await getTrc20Balance(tron.tronRpcUrl, token, tron.tronUserAddress.bytes);
          requestId = await startTronDeposit(context, tron, {
            amount: held + 1n,
            allowUnfunded: true,
          });
        }
        banner([`Resume with TRON_FAILURE_DEPOSIT_REQUEST_ID=${requestId}`]);
        const id = requestId;

        const outcome = await withTronBlockPusher(tron.tronRpcUrl, tron.funder, async () => {
          const signed = await pollTronSignedTransaction(context, {
            requestId: id,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
            expectedOwner: tron.tronUserAddress.base58,
          });
          const info = await broadcastTron(tron, { ...signed, timeoutMs: POLL_TIMEOUT_MS });
          expect(info.receiptResult, "the over-balance transfer must revert").toBe("REVERT");
          return pollTronRespondBidirectional(context, {
            requestId: id,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
          });
        });
        expect(outcome.succeeded).toBe(false);

        const wallet = await session.wallet();
        const before = (await wallet.facade.waitForSyncedState()).shielded.balances;
        await settleTronDeposit(context, outcome);
        const after = (await wallet.facade.waitForSyncedState()).shielded.balances;
        expect(after).toEqual(before);

        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(ledger.bidirectionalTronDepositMap.member(requestIdBytes(id))).toBe(false);
      },
      3 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );
  },
);
