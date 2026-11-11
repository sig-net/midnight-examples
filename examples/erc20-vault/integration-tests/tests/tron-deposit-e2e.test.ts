import { requestIdBytes, type RequestIdHex, tronAddressFromEvm } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_DEPOSIT_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  resolveAllowedTronTokens,
  resolveTokenFeesFor,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import { banner, logSkip } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { addAllowedTronTokens } from "../src/flows/add-allowed-tron-tokens.ts";
import { broadcastTron } from "../src/flows/broadcast-tron.ts";
import { settleTronDeposit } from "../src/flows/complete-tron-deposit.ts";
import { pollTronRespondBidirectional } from "../src/flows/poll-tron-respond-bidirectional.ts";
import {
  pollTronSignedTransaction,
  type SignedTronTransaction,
} from "../src/flows/poll-tron-signature-response.ts";
import type { RespondOutcome } from "../src/flows/respond-output.ts";
import { startTronDeposit, TRON_DEPOSIT_FEE_LIMIT } from "../src/flows/start-tron-deposit.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { withTronBlockPusher } from "../src/tron-block-pusher.ts";
import { createTronContext, type TronContext } from "../src/tron-context.ts";
import { getTrc20Balance, getTrxBalance } from "../src/tron-http.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTronTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env);

const DEPOSIT_AMOUNT = 1_000_000n;

let tronContext: TronContext | undefined;
const tron = async (): Promise<TronContext> => (tronContext ??= await createTronContext(env));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron deposit happy day e2e",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "preflight: the vault is initialised with a Tron start height, and the deployer allows the test TRC-20",
      async () => {
        const context = await session.vaultContext();
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.initialised, "run tests/happy-day-e2e.test.ts first").toBe(true);
        expect(state.tronLastSeen, "initialise read TRON_RPC_URL's height").toBeGreaterThan(0n);

        await addAllowedTronTokens(
          context,
          resolveTokenFeesFor(env, resolveAllowedTronTokens(env)),
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.allowedTronTokens.member((await tron()).trc20Address)).toBe(true);
      },
      15 * MINUTE,
    );

    it(
      "funding preflight: the user's Tron account holds the deposit and its fee limit",
      async () => {
        const { tronRpcUrl, trc20Address, tronUserAddress } = await tron();
        const trx = await getTrxBalance(tronRpcUrl, tronUserAddress.bytes);
        expect(trx, `fund ${tronUserAddress.base58} with TRX`).toBeGreaterThanOrEqual(
          TRON_DEPOSIT_FEE_LIMIT,
        );
        const tokens = await getTrc20Balance(
          tronRpcUrl,
          tronAddressFromEvm(trc20Address),
          tronUserAddress.bytes,
        );
        expect(tokens, `fund ${tronUserAddress.base58} with the TRC-20`).toBeGreaterThanOrEqual(
          DEPOSIT_AMOUNT,
        );
      },
      MINUTE,
    );

    let requestId: RequestIdHex;
    let signed: SignedTronTransaction;
    let outcome: RespondOutcome;
    let vaultTokensBefore: bigint;

    it(
      "startTronDeposit + sendTronDeposit record the request under the user's derivation path",
      async () => {
        const context = await session.vaultContext();
        const reuse = env.TRON_DEPOSIT_REQUEST_ID as RequestIdHex | undefined;
        requestId =
          reuse ?? (await startTronDeposit(context, await tron(), { amount: DEPOSIT_AMOUNT }));
        const record = await session
          .responseReader(VAULT_TRON_DEPOSIT_REQUESTS_PATH)
          .getTronSignatureRequest(requestId);
        expect(record.path).toEqual(context.identity.commitment);
        expect(record.txParams.callValue).toBe(0n);
        expect(record.txParams.expiration - record.txParams.timestamp).toBe(3_600_000n);
        banner([
          `Tron deposit ${requestId} sent.`,
          `Resume with TRON_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      "the MPC signs the Tron transaction id with the user's derived Tron key",
      async () => {
        const context = await session.vaultContext();
        const { tronRpcUrl, funder, tronUserAddress } = await tron();
        signed = await withTronBlockPusher(tronRpcUrl, funder, () =>
          pollTronSignedTransaction(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
            expectedOwner: tronUserAddress.base58,
          }),
        );
        expect(signed.signedTransaction.length).toBeGreaterThan(0);
      },
      POLL_TIMEOUT_MS + MINUTE,
    );

    it(
      "broadcast: the signed transfer executes on Tron and pays the vault's Tron account",
      async () => {
        const t = await tron();
        const token = tronAddressFromEvm(t.trc20Address);
        const vaultBefore = await getTrc20Balance(t.tronRpcUrl, token, t.tronVaultAddress.bytes);
        const info = await withTronBlockPusher(t.tronRpcUrl, t.funder, () =>
          broadcastTron(t, { ...signed, timeoutMs: POLL_TIMEOUT_MS }),
        );
        expect(info.receiptResult).toBe("SUCCESS");
        const vaultAfter = await getTrc20Balance(t.tronRpcUrl, token, t.tronVaultAddress.bytes);
        if (vaultAfter === vaultBefore) {
          logSkip("vault balance delta", "the transfer landed in a prior run");
          return;
        }
        expect(vaultAfter - vaultBefore).toBe(DEPOSIT_AMOUNT);
      },
      POLL_TIMEOUT_MS + MINUTE,
    );

    it(
      "the MPC attests the transfer executed, over the empty output",
      async () => {
        const context = await session.vaultContext();
        const { tronRpcUrl, funder } = await tron();
        outcome = await withTronBlockPusher(tronRpcUrl, funder, () =>
          pollTronRespondBidirectional(context, {
            requestId,
            intervalMs: 1000,
            timeoutMs: POLL_TIMEOUT_MS,
          }),
        );
        expect(outcome.succeeded).toBe(true);
        expect(outcome.serializedOutput).toEqual(new Uint8Array(0));
      },
      POLL_TIMEOUT_MS + MINUTE,
    );

    it(
      "completeTronDeposit mints the Tron vault token and consumes the request",
      async () => {
        const context = await session.vaultContext();
        const wallet = await session.wallet();
        const color = vaultTronTokenType((await tron()).trc20Address, context.vaultContractAddress);
        vaultTokensBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        if (!ledger.bidirectionalTronDepositMap.member(requestIdBytes(requestId))) {
          logSkip("completeTronDeposit", `request ${requestId} already claimed`);
          return;
        }
        await settleTronDeposit(context, outcome);

        await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) >= vaultTokensBefore + DEPOSIT_AMOUNT,
        );
        const after = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(after.bidirectionalTronDepositMap.member(requestIdBytes(requestId))).toBe(false);
        expect(after.tronLastSeen).toBeGreaterThanOrEqual(outcome.event.blockHeight);
      },
      15 * MINUTE,
    );
  },
);
