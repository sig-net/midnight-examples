import type { RequestIdHex } from "@sig-net/midnight";
import {
  deriveAccountKeys,
  getMidnightNodeConfig,
  withSyncedWalletFacade,
} from "@sig-net/midnight-contract-deploy";
import { banner, logSkip, requireEnv } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { runTronDepositRoundTrip } from "../src/flows/tron-deposit-round-trip.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createTronContext } from "../src/tron-context.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env);

const DEPOSIT_AMOUNT = 1_000_000n;

const RECIPIENT_SEED = "0000000000000000000000000000000000000000000000000000000000000045";

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron deposit → claim to a recipient that is not the caller e2e",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "the depositor's claim mints the Tron vault token to the second wallet",
      async () => {
        const nodeConfig = getMidnightNodeConfig(env);
        const keys = deriveAccountKeys(RECIPIENT_SEED, nodeConfig.networkId);
        const tron = await createTronContext(env);
        const color = vaultTronTokenType(
          tron.trc20Address,
          requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
        );
        const readRecipientBalance = (): Promise<bigint> =>
          withSyncedWalletFacade(keys, nodeConfig, (_facade, state) =>
            Promise.resolve(state.shielded.balances[color] ?? 0n),
          );
        const before = await readRecipientBalance();

        const { requestId, claimed } = await runTronDepositRoundTrip(session, tron, {
          amount: DEPOSIT_AMOUNT,
          reuseRequestId: env.TRON_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID as
            RequestIdHex | undefined,
          claimRecipient: {
            coinPublicKey: keys.shieldedSecretKeys.coinPublicKey,
            encryptionPublicKey: keys.shieldedSecretKeys.encryptionPublicKey,
          },
        });
        banner([`Resume with TRON_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID=${requestId}`]);
        if (!claimed) {
          logSkip("recipient balance delta", `request ${requestId} was claimed by a prior run`);
          return;
        }
        expect(await readRecipientBalance()).toBe(before + DEPOSIT_AMOUNT);
      },
      3 * POLL_TIMEOUT_MS + 20 * MINUTE,
    );
  },
);
