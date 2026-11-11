import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
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
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env);

const WINDOW_MS = 60_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron deposit expiry e2e: an expired transaction is attested unviable and closes",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "a signed deposit left unbroadcast past its expiration is attested unviable and closes without minting",
      async () => {
        const context = await session.vaultContext();
        const tron = await createTronContext(env);
        const requestId =
          (env.TRON_EXPIRY_DEPOSIT_REQUEST_ID as RequestIdHex | undefined) ??
          (await startTronDeposit(context, tron, { amount: 1n, windowMs: WINDOW_MS }));
        banner([`Resume with TRON_EXPIRY_DEPOSIT_REQUEST_ID=${requestId}`]);

        const outcome = await withTronBlockPusher(tron.tronRpcUrl, tron.funder, async () => {
          const signed = await pollTronSignedTransaction(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
            expectedOwner: tron.tronUserAddress.base58,
          });
          const attested = await pollTronRespondBidirectional(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS + Number(WINDOW_MS),
          });
          await expect(
            broadcastTron(tron, { ...signed, timeoutMs: MINUTE }),
            "the node refuses an expired transaction",
          ).rejects.toThrow(/broadcasthex refused/);
          return attested;
        });
        expect(OutputKind[outcome.event.outputKind]).toBe(OutputKind[OutputKind.unviable]);

        await settleTronDeposit(context, outcome);
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId))).toBe(false);
      },
      3 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );
  },
);
