import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { completeTronDeposit } from "../src/flows/complete-tron-deposit.ts";
import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createTronContext } from "../src/tron-context.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env);

const FALSE_CLAIMER_SEED = "0000000000000000000000000000000000000000000000000000000000000043";
const falseClaimerSession = createVaultSession({
  ...env,
  USER_SEED: FALSE_CLAIMER_SEED,
  VAULT_USER_SECRET_KEY: FALSE_CLAIMER_SEED,
});

const DEPOSIT_AMOUNT = 1_000_000n;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron false-claimer e2e: a Tron deposit is only claimable by its requester",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await falseClaimerSession.stop();
    });

    let requestId: RequestIdHex;
    let requestOnLedger: boolean;

    it(
      "arrange: a Tron deposit round trip up to (not including) the claim",
      async () => {
        const result = await runTronDepositRoundTrip(session, await createTronContext(env), {
          amount: DEPOSIT_AMOUNT,
          reuseRequestId: env.TRON_FALSE_CLAIMER_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
          skipClaim: true,
        });
        requestId = result.requestId;
        expect(result.claimed, "skipClaim must leave the claim to this file").toBe(false);
        const context = await session.vaultContext();
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        requestOnLedger = ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId));
        banner([`Resume with TRON_FALSE_CLAIMER_DEPOSIT_REQUEST_ID=${requestId}`]);
      },
      3 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "act: a claim under a second identity rejects and leaves the request on the ledger",
      async () => {
        if (!requestOnLedger) {
          logSkip("false claim attempt", `request ${requestId} already claimed by a prior run`);
          return;
        }
        const falseClaimerContext = await falseClaimerSession.vaultContext();
        await expect(completeTronDeposit(falseClaimerContext, { requestId })).rejects.toThrow(
          /Not the requester/,
        );
        const context = await session.vaultContext();
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId))).toBe(true);
      },
      POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    it(
      "cleanup: the rightful identity claims the Tron deposit",
      async () => {
        if (!requestOnLedger) {
          logSkip("rightful claim", `request ${requestId} already claimed by a prior run`);
          return;
        }
        const context = await session.vaultContext();
        await completeTronDeposit(context, { requestId });
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId))).toBe(false);
      },
      POLL_TIMEOUT_MS + 15 * MINUTE,
    );
  },
);
