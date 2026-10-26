// How the fee variables resolve into the fees initialise and addAllowedToken
// stamp on every token, and into the wallet the fee coins are minted to.
// Offline: resolution only parses the environment and derives keys from a seed.

import { deriveAccountKeys, MidnightNetwork } from "@sig-net/midnight-contract-deploy";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_FEE, resolveFeeRecipient, resolveTokenFees } from "../src/fee-config.ts";

describe("resolveTokenFees", () => {
  /** A fee environment and the fees it resolves to. */
  interface ResolvedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly fees: { withdraw: bigint; swap: bigint; supply: bigint; redeem: bigint };
  }

  const RESOLVED: readonly ResolvedCase[] = [
    {
      name: "nothing set to the default for every action",
      env: {},
      fees: {
        withdraw: DEFAULT_TOKEN_FEE,
        swap: DEFAULT_TOKEN_FEE,
        supply: DEFAULT_TOKEN_FEE,
        redeem: DEFAULT_TOKEN_FEE,
      },
    },
    {
      name: "every action set",
      env: {
        VAULT_FEE_WITHDRAW: "1",
        VAULT_FEE_SWAP: "2",
        VAULT_FEE_SUPPLY: "3",
        VAULT_FEE_REDEEM: "4",
      },
      fees: { withdraw: 1n, swap: 2n, supply: 3n, redeem: 4n },
    },
    {
      name: "one action set, the rest defaulted",
      env: { VAULT_FEE_SWAP: "0" },
      fees: {
        withdraw: DEFAULT_TOKEN_FEE,
        swap: 0n,
        supply: DEFAULT_TOKEN_FEE,
        redeem: DEFAULT_TOKEN_FEE,
      },
    },
    {
      name: "a blank value to the default",
      env: { VAULT_FEE_REDEEM: "" },
      fees: {
        withdraw: DEFAULT_TOKEN_FEE,
        swap: DEFAULT_TOKEN_FEE,
        supply: DEFAULT_TOKEN_FEE,
        redeem: DEFAULT_TOKEN_FEE,
      },
    },
    {
      name: "the Uint<64> maximum",
      env: { VAULT_FEE_WITHDRAW: "18446744073709551615" },
      fees: {
        withdraw: 18446744073709551615n,
        swap: DEFAULT_TOKEN_FEE,
        supply: DEFAULT_TOKEN_FEE,
        redeem: DEFAULT_TOKEN_FEE,
      },
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ env, fees }) => {
    expect(resolveTokenFees(env)).toEqual(fees);
  });

  it.each(["-1", "1.5", "abc", "01", "18446744073709551616"])(
    "refuses VAULT_FEE_SUPPLY=%s",
    (value) => {
      expect(() => resolveTokenFees({ VAULT_FEE_SUPPLY: value })).toThrow(/VAULT_FEE_SUPPLY/);
    },
  );
});

describe("resolveFeeRecipient", () => {
  const DEPLOYER_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
  const COIN_KEY = "ab".repeat(32);
  const ENC_KEY = "cd".repeat(32);

  it("defaults to the deployer wallet's shielded keys for the run's network", () => {
    const { shieldedSecretKeys } = deriveAccountKeys(DEPLOYER_SEED, MidnightNetwork.Undeployed);
    expect(resolveFeeRecipient({ DEPLOYER_SEED })).toEqual({
      coinPublicKey: shieldedSecretKeys.coinPublicKey,
      encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
    });
  });

  it("takes the pair when both are set, lowercased", () => {
    expect(
      resolveFeeRecipient({
        VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY: COIN_KEY.toUpperCase(),
        VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY: ENC_KEY,
      }),
    ).toEqual({ coinPublicKey: COIN_KEY, encryptionPublicKey: ENC_KEY });
  });

  /** An environment the resolution refuses, and the refusal. */
  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "only the coin key",
      env: { DEPLOYER_SEED, VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY: COIN_KEY },
      error: /set both or neither/,
    },
    {
      name: "only the encryption key",
      env: { DEPLOYER_SEED, VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY: ENC_KEY },
      error: /set both or neither/,
    },
    {
      name: "a short coin key",
      env: {
        VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY: "abcd",
        VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY: ENC_KEY,
      },
      error: /VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY must be 32 bytes of hex/,
    },
    {
      name: "a non-hex encryption key",
      env: {
        VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY: COIN_KEY,
        VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY: "zz".repeat(32),
      },
      error: /VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY must be 32 bytes of hex/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, error }) => {
    expect(() => resolveFeeRecipient(env)).toThrow(error);
  });
});
