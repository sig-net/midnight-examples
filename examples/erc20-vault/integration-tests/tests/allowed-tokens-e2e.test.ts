// The allowed-tokens e2e flow: the vault's ERC20 allow list on a live stack.
// startDeposit and startSwap (for the ERC20 it buys) refuse an ERC20 the vault
// does not allow, only the deployer can add one, and once added the ledger
// allows it. The token is a fresh random address each run, so the vault can
// never have allowed it before, and the list only grows, so every run adds one.
//
// The refused calls fail in the circuit during local transaction building,
// before proving or balancing, so nothing reaches the chain and the stranger's
// wallet seed needs no funding. The stranger overrides USER_SEED and
// VAULT_USER_SECRET_KEY together: a changed secret under the SAME seed would
// hit midnight-js's persisted private state and the stale identity would win.
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialise, and the
// allowing of the ERC20s the suites move, live there.
import { bytesToHex, hexToBytes } from "@sig-net/midnight";
import {
  evmAddressBytes,
  newInputIndex,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import {
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
} from "../src/evm-transfer.ts";
import { addAllowedTokens } from "../src/flows/add-allowed-tokens.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset: the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

// The deployer's session: the suites' user identity is the deployer's.
const session = createVaultSession(env);

// The stranger's seed AND identity secret: one fixed constant serving as both,
// different from every other suite's (`…42`, `…43`).
const STRANGER_SEED = "0000000000000000000000000000000000000000000000000000000000000044";

const strangerSession = createVaultSession({
  ...env,
  USER_SEED: STRANGER_SEED,
  VAULT_USER_SECRET_KEY: STRANGER_SEED,
});

// An ERC20 no vault has allowed: fresh each run.
const UNLISTED_ERC20 = `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(20)))}`;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault allowed-tokens e2e: only ERC20s the deployer allows move into the vault",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
      await strangerSession.stop();
    });

    it(
      "startDeposit refuses an ERC20 the vault does not allow",
      async () => {
        const context = await session.vaultContext();
        await expect(
          context.vault.callTx.startDeposit(
            newInputIndex(),
            0n,
            {
              gasLimit: ERC20_TRANSFER_GAS_LIMIT,
              maxFeePerGas: ERC20_TRANSFER_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
            },
            { erc20Address: evmAddressBytes(UNLISTED_ERC20), amount: 1n },
          ),
        ).rejects.toThrow(/ERC20 not allowed/);
      },
      5 * MINUTE,
    );

    it(
      "startSwap refuses to buy an ERC20 the vault does not allow",
      async () => {
        const context = await session.vaultContext();
        await expect(
          context.vault.callTx.startSwap(
            newInputIndex(),
            {
              erc20AddressIn: evmAddressBytes(context.erc20Address),
              erc20AddressOut: evmAddressBytes(UNLISTED_ERC20),
              fee: 500n,
              amountOut: 1n,
              amountInMaximum: 1n,
            },
            {
              nonce: crypto.getRandomValues(new Uint8Array(32)),
              color: hexToBytes(vaultTokenType(context.erc20Address, context.vaultContractAddress)),
              value: 1n,
            },
          ),
        ).rejects.toThrow(/erc20AddressOut not allowed/);
      },
      5 * MINUTE,
    );

    it(
      "addAllowedToken refuses a caller who is not the deployer",
      async () => {
        const stranger = await strangerSession.vaultContext();
        await expect(addAllowedTokens(stranger, [UNLISTED_ERC20])).rejects.toThrow(
          /Not the deployer/,
        );
      },
      10 * MINUTE,
    );

    it(
      "addAllowedToken, called by the deployer, allows the ERC20",
      async () => {
        const context = await session.vaultContext();
        const added = await addAllowedTokens(context, [UNLISTED_ERC20]);
        expect(added).toEqual([UNLISTED_ERC20]);

        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        expect(state.allowedTokens.member(evmAddressBytes(UNLISTED_ERC20))).toBe(true);

        // A rerun submits nothing: the ledger already allows it.
        expect(await addAllowedTokens(context, [UNLISTED_ERC20])).toEqual([]);
      },
      10 * MINUTE,
    );
  },
);
