// How the fee variables resolve into the fees initialise and addAllowedToken
// stamp on each token, the per-token map setTokenFees reprices from, and the
// wallet the fee coins are minted to. Offline: resolution only parses the
// environment and derives keys from a seed.

import { deriveAccountKeys, MidnightNetwork } from "@sig-net/midnight-contract-deploy";
import type { TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOKEN_FEE,
  resolveFeeRecipient,
  resolveFlatTokenFees,
  resolveTokenFeesByToken,
  resolveTokenFeesFor,
} from "../src/fee-config.ts";

const DEFAULT_FEES: TokenFees = {
  withdraw: DEFAULT_TOKEN_FEE,
  swap: DEFAULT_TOKEN_FEE,
  supply: DEFAULT_TOKEN_FEE,
  redeem: DEFAULT_TOKEN_FEE,
};

// Every flat variable set, the environment a deployed network needs.
const FLAT_FEES_SET = {
  VAULT_FEE_WITHDRAW: "1",
  VAULT_FEE_SWAP: "2",
  VAULT_FEE_SUPPLY: "3",
  VAULT_FEE_REDEEM: "4",
} as const;
const FLAT_FEES: TokenFees = { withdraw: 1n, swap: 2n, supply: 3n, redeem: 4n };

const TOKEN_A = `0x${"aa".repeat(20)}`;
const TOKEN_B = `0x${"bb".repeat(20)}`;

describe("resolveFlatTokenFees", () => {
  /** A fee environment and the fees it resolves to. */
  interface ResolvedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly fees: TokenFees;
  }

  const RESOLVED: readonly ResolvedCase[] = [
    {
      name: "nothing set to the default for every action on the local stack",
      env: {},
      fees: DEFAULT_FEES,
    },
    { name: "every action set", env: FLAT_FEES_SET, fees: FLAT_FEES },
    {
      name: "every action set on a deployed network",
      env: { ...FLAT_FEES_SET, NETWORK_ID: "stagenet" },
      fees: FLAT_FEES,
    },
    {
      name: "one action set, the rest defaulted on the local stack",
      env: { VAULT_FEE_SWAP: "0" },
      fees: { ...DEFAULT_FEES, swap: 0n },
    },
    {
      name: "a blank value to the default on the local stack",
      env: { VAULT_FEE_REDEEM: "" },
      fees: DEFAULT_FEES,
    },
    {
      name: "the Uint<64> maximum",
      env: { VAULT_FEE_WITHDRAW: "18446744073709551615" },
      fees: { ...DEFAULT_FEES, withdraw: 18446744073709551615n },
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ env, fees }) => {
    expect(resolveFlatTokenFees(env)).toEqual(fees);
  });

  it.each(["-1", "1.5", "abc", "01", "18446744073709551616"])(
    "refuses VAULT_FEE_SUPPLY=%s",
    (value) => {
      expect(() => resolveFlatTokenFees({ VAULT_FEE_SUPPLY: value })).toThrow(/VAULT_FEE_SUPPLY/);
    },
  );

  it.each(["VAULT_FEE_WITHDRAW", "VAULT_FEE_SWAP", "VAULT_FEE_SUPPLY", "VAULT_FEE_REDEEM"])(
    "refuses an unset %s on a deployed network",
    (name) => {
      expect(() =>
        resolveFlatTokenFees({ ...FLAT_FEES_SET, NETWORK_ID: "stagenet", [name]: undefined }),
      ).toThrow(new RegExp(`${name} is required on "stagenet"`));
    },
  );
});

describe("resolveTokenFeesByToken", () => {
  /** A VAULT_TOKEN_FEES value and the map it resolves to. */
  interface ResolvedCase {
    readonly name: string;
    readonly value: string | undefined;
    readonly byToken: readonly (readonly [string, TokenFees])[];
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "unset to no token", value: undefined, byToken: [] },
    { name: "blank to no token", value: "", byToken: [] },
    { name: "an empty object to no token", value: "{}", byToken: [] },
    {
      name: "string fees",
      value: `{"${TOKEN_A}":{"withdraw":"1","swap":"2","supply":"3","redeem":"4"}}`,
      byToken: [[TOKEN_A, FLAT_FEES]],
    },
    {
      name: "integer fees",
      value: `{"${TOKEN_A}":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      byToken: [[TOKEN_A, FLAT_FEES]],
    },
    {
      name: "a key without its 0x prefix, in upper case, to its lowercased 0x form",
      value: `{"${"AA".repeat(20)}":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      byToken: [[TOKEN_A, FLAT_FEES]],
    },
    {
      name: "two tokens in listed order",
      value:
        `{"${TOKEN_B}":{"withdraw":0,"swap":0,"supply":0,"redeem":0},` +
        `"${TOKEN_A}":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      byToken: [
        [TOKEN_B, { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n }],
        [TOKEN_A, FLAT_FEES],
      ],
    },
    {
      name: "the Uint<64> maximum as a string",
      value: `{"${TOKEN_A}":{"withdraw":"18446744073709551615","swap":0,"supply":0,"redeem":0}}`,
      byToken: [[TOKEN_A, { withdraw: 18446744073709551615n, swap: 0n, supply: 0n, redeem: 0n }]],
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ value, byToken }) => {
    expect([...resolveTokenFeesByToken({ VAULT_TOKEN_FEES: value })]).toEqual(byToken);
  });

  /** A VAULT_TOKEN_FEES value the resolution refuses, and the refusal. */
  interface RefusedCase {
    readonly name: string;
    readonly value: string;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    { name: "text that is not JSON", value: "nope", error: /must be a JSON object/ },
    { name: "a JSON array", value: "[]", error: /must be a JSON object/ },
    { name: "a JSON number", value: "7", error: /must be a JSON object/ },
    {
      name: "a key that is not an address",
      value: `{"0x1234":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      error: /expected a 20-byte 0x hex EVM address/,
    },
    {
      name: "the zero address",
      value: `{"0x${"00".repeat(20)}":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      error: /zero address/,
    },
    {
      name: "one token under two spellings",
      value:
        `{"${TOKEN_A}":{"withdraw":1,"swap":2,"supply":3,"redeem":4},` +
        `"${TOKEN_A.toUpperCase().replace("0X", "0x")}":{"withdraw":1,"swap":2,"supply":3,"redeem":4}}`,
      error: /twice/,
    },
    {
      name: "an entry that is not an object",
      value: `{"${TOKEN_A}":5}`,
      error: /must be an object naming withdraw, swap, supply and redeem/,
    },
    {
      name: "an entry missing an action",
      value: `{"${TOKEN_A}":{"withdraw":1,"swap":2,"supply":3}}`,
      error: /is missing redeem/,
    },
    {
      name: "an entry naming an action that charges no fee",
      value: `{"${TOKEN_A}":{"withdraw":1,"swap":2,"supply":3,"redeem":4,"deposit":5}}`,
      error: /"deposit", which is not a fee-charging action/,
    },
    {
      name: "a negative fee",
      value: `{"${TOKEN_A}":{"withdraw":-1,"swap":2,"supply":3,"redeem":4}}`,
      error: /VAULT_TOKEN_FEES\[.*\]\.withdraw must be a non-negative integer/,
    },
    {
      name: "a fractional fee",
      value: `{"${TOKEN_A}":{"withdraw":1.5,"swap":2,"supply":3,"redeem":4}}`,
      error: /VAULT_TOKEN_FEES\[.*\]\.withdraw must be an integer/,
    },
    {
      name: "a boolean fee",
      value: `{"${TOKEN_A}":{"withdraw":true,"swap":2,"supply":3,"redeem":4}}`,
      error: /VAULT_TOKEN_FEES\[.*\]\.withdraw must be an integer/,
    },
    {
      name: "a fee above the Uint<64> maximum",
      value: `{"${TOKEN_A}":{"withdraw":"18446744073709551616","swap":2,"supply":3,"redeem":4}}`,
      error: /must fit a Uint<64>/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ value, error }) => {
    expect(() => resolveTokenFeesByToken({ VAULT_TOKEN_FEES: value })).toThrow(error);
  });
});

describe("resolveTokenFeesFor", () => {
  const PRICED_A = `{"${TOKEN_A}":{"withdraw":"10","swap":"20","supply":"30","redeem":"40"}}`;
  const PRICED_A_FEES: TokenFees = { withdraw: 10n, swap: 20n, supply: 30n, redeem: 40n };

  /** The tokens asked for under an environment, and the fees each gets. */
  interface ResolvedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly tokens: readonly string[];
    readonly fees: readonly (readonly [string, TokenFees])[];
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "no tokens to an empty map", env: {}, tokens: [], fees: [] },
    {
      name: "an unpriced token to the flat fees",
      env: FLAT_FEES_SET,
      tokens: [TOKEN_A],
      fees: [[TOKEN_A, FLAT_FEES]],
    },
    {
      name: "an unpriced token to the local defaults when nothing is set",
      env: {},
      tokens: [TOKEN_A],
      fees: [[TOKEN_A, DEFAULT_FEES]],
    },
    {
      name: "a priced token to its entry, the flat values unread",
      env: { VAULT_TOKEN_FEES: PRICED_A, NETWORK_ID: "stagenet" },
      tokens: [TOKEN_A],
      fees: [[TOKEN_A, PRICED_A_FEES]],
    },
    {
      name: "a priced token in another case to its entry under the lowercased key",
      env: { VAULT_TOKEN_FEES: PRICED_A, NETWORK_ID: "stagenet" },
      tokens: [TOKEN_A.toUpperCase().replace("0X", "0x")],
      fees: [[TOKEN_A, PRICED_A_FEES]],
    },
    {
      name: "a priced and an unpriced token in asked order",
      env: { VAULT_TOKEN_FEES: PRICED_A, ...FLAT_FEES_SET },
      tokens: [TOKEN_B, TOKEN_A],
      fees: [
        [TOKEN_B, FLAT_FEES],
        [TOKEN_A, PRICED_A_FEES],
      ],
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ env, tokens, fees }) => {
    expect([...resolveTokenFeesFor(env, tokens)]).toEqual(fees);
  });

  /** The tokens asked for under an environment the resolution refuses, and the refusal. */
  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly tokens: readonly string[];
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "an unpriced token on a deployed network with no flat fees",
      env: { VAULT_TOKEN_FEES: PRICED_A, NETWORK_ID: "stagenet" },
      tokens: [TOKEN_B],
      error: /VAULT_FEE_WITHDRAW is required on "stagenet"/,
    },
    {
      name: "a token that is not an address",
      env: FLAT_FEES_SET,
      tokens: ["0x1234"],
      error: /expected a 20-byte 0x hex EVM address/,
    },
    {
      name: "a malformed map, whatever the tokens",
      env: { VAULT_TOKEN_FEES: "nope", ...FLAT_FEES_SET },
      tokens: [],
      error: /must be a JSON object/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, tokens, error }) => {
    expect(() => resolveTokenFeesFor(env, tokens)).toThrow(error);
  });
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
