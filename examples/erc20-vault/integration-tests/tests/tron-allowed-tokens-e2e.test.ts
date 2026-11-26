import { bytesToHex } from "@sig-net/midnight";
import {
  evmAddressBytes,
  newInputIndex,
  pureCircuits,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveTronTokenListings } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { addAllowedTronTokens } from "../src/flows/add-allowed-tron-tokens.ts";
import { TRON_DEPOSIT_FEE_LIMIT } from "../src/flows/start-tron-deposit.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();
const session = createVaultSession(env, "user");

const STRANGER_SEED = "0000000000000000000000000000000000000000000000000000000000000044";
const strangerSession = createVaultSession(
  {
    ...env,
    USER_SEED: STRANGER_SEED,
    VAULT_USER_SECRET_KEY: STRANGER_SEED,
  },
  "stranger",
);

const UNLISTED_TRC20 = `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(20)))}`;

// A shifted listing: one coin unit of it counts 10^6 base units.
const UNLISTED_FACTOR = 1_000_000n;

const unlistedListing = () =>
  resolveTronTokenListings({
    ...env,
    TRON_ALLOWED_TOKENS: UNLISTED_TRC20,
    TRON_TOKEN_FACTORS: JSON.stringify({ [UNLISTED_TRC20]: String(UNLISTED_FACTOR) }),
  });

const TRON_TX = {
  refBlockBytes: new Uint8Array(2),
  refBlockHash: new Uint8Array(8),
  timestamp: 1_700_000_000_000n,
  expiration: 1_700_003_600_000n,
  feeLimit: TRON_DEPOSIT_FEE_LIMIT,
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS || !env.TRON_RPC_URL)(
  "erc20-vault Tron allowed-tokens e2e: only TRC-20s the deployer allows move into the vault",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await strangerSession.stop();
    });

    it(
      "startTronDeposit refuses a TRC-20 the vault never allowed",
      async () => {
        const context = await session.vaultContext();
        await expect(
          context.vault.callTx.startTronDeposit(newInputIndex(), TRON_TX, {
            tokenAddress: evmAddressBytes(UNLISTED_TRC20),
            amount: 1n,
          }),
        ).rejects.toThrow(/TRC-20 not allowed/);
      },
      5 * MINUTE,
    );

    it(
      "a stranger cannot allow a TRC-20",
      async () => {
        const stranger = await strangerSession.vaultContext();
        await expect(addAllowedTronTokens(stranger, unlistedListing())).rejects.toThrow(
          /Not the deployer/,
        );
      },
      5 * MINUTE,
    );

    it(
      "the deployer lists the TRC-20 with its fees and factor, and the ledger holds it in the Tron map only",
      async () => {
        const context = await session.vaultContext();
        const tokens = unlistedListing();
        const added = await addAllowedTronTokens(context, tokens);
        expect(added).toEqual([UNLISTED_TRC20]);
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        const token = evmAddressBytes(UNLISTED_TRC20);
        const colour = pureCircuits.tronCoinColour(token, UNLISTED_FACTOR);
        expect(ledger.allowedTronTokens.lookup(token)).toEqual({
          fees: tokens.get(UNLISTED_TRC20)?.fees,
          factor: UNLISTED_FACTOR,
          colour,
        });
        expect(colour).not.toEqual(pureCircuits.vaultTronTokenDomainSeparator(token));
        expect(ledger.allowedTokens.member(evmAddressBytes(UNLISTED_TRC20))).toBe(false);
      },
      10 * MINUTE,
    );
  },
);
