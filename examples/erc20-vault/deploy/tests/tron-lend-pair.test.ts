// How the TRON_LEND_* variables resolve into the pair setTronLendPair records. Offline:
// resolution only parses the environment.

import { describe, expect, it } from "vitest";

import { addAllowedTronTokensToVault } from "../src/add-allowed-tron-tokens.ts";
import {
  assertTronLendPairListed,
  resolveTronLendPair,
  type TronLendPair,
} from "../src/set-tron-lend-pair.ts";
import type { TronTokenListing } from "../src/tron-targets.ts";

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_EVM_FORM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const JUSDT_V2_BASE58 = "TXejU9jmd1ooQyY3Zmpo15yN7MjSFYUESg";
const JUSDT_V2_EVM_FORM = "0xedd44bf022ef0fd07c5237d7f6728818f019f305";
const SHARE_TOKEN = `0x${"bb".repeat(20)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const SHARE_FACTOR = 1_000_000_000_000n;

const VALID_ENV = {
  TRON_LEND_UNDERLYING: USDT_BASE58,
  TRON_LEND_SHARE_TOKEN: SHARE_TOKEN,
  TRON_LEND_MIN_SUPPLY: "1000000",
  TRON_TOKEN_FACTORS: JSON.stringify({ [SHARE_TOKEN]: "1000000000000" }),
} as const;

describe("resolveTronLendPair", () => {
  interface ResolvedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly pair: TronLendPair | undefined;
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "nothing set to no pair", env: {}, pair: undefined },
    {
      name: "all three blank to no pair",
      env: { TRON_LEND_UNDERLYING: " ", TRON_LEND_SHARE_TOKEN: "", TRON_LEND_MIN_SUPPLY: "" },
      pair: undefined,
    },
    {
      name: "a base58 underlying and a hex share token to their 20-byte forms",
      env: VALID_ENV,
      pair: {
        underlying: USDT_EVM_FORM,
        shareToken: SHARE_TOKEN,
        minSupply: 1_000_000n,
        shareFactor: SHARE_FACTOR,
      },
    },
    {
      name: "the mainnet JustLend V2 USDT vault as the share token",
      env: {
        ...VALID_ENV,
        TRON_LEND_SHARE_TOKEN: JUSDT_V2_BASE58,
        TRON_TOKEN_FACTORS: JSON.stringify({ [JUSDT_V2_BASE58]: "1000000000000" }),
      },
      pair: {
        underlying: USDT_EVM_FORM,
        shareToken: JUSDT_V2_EVM_FORM,
        minSupply: 1_000_000n,
        shareFactor: SHARE_FACTOR,
      },
    },
    {
      name: "the Uint<64> maximum minimum",
      env: { ...VALID_ENV, TRON_LEND_MIN_SUPPLY: "18446744073709551615" },
      pair: {
        underlying: USDT_EVM_FORM,
        shareToken: SHARE_TOKEN,
        minSupply: 2n ** 64n - 1n,
        shareFactor: SHARE_FACTOR,
      },
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ env, pair }) => {
    expect(resolveTronLendPair(env)).toEqual(pair);
  });

  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a pair without its minimum",
      env: { ...VALID_ENV, TRON_LEND_MIN_SUPPLY: undefined },
      error: /set all three or none/,
    },
    {
      name: "a minimum alone",
      env: { TRON_LEND_MIN_SUPPLY: "1" },
      error: /set all three or none/,
    },
    {
      name: "a zero minimum",
      env: { ...VALID_ENV, TRON_LEND_MIN_SUPPLY: "0" },
      error: /TRON_LEND_MIN_SUPPLY must be a positive integer that fits a Uint<64>, got "0"/,
    },
    {
      name: "a minimum wider than Uint<64>",
      env: { ...VALID_ENV, TRON_LEND_MIN_SUPPLY: "18446744073709551616" },
      error: /TRON_LEND_MIN_SUPPLY must be a positive integer that fits a Uint<64>/,
    },
    {
      name: "a fractional minimum",
      env: { ...VALID_ENV, TRON_LEND_MIN_SUPPLY: "1.5" },
      error: /TRON_LEND_MIN_SUPPLY must be a positive integer/,
    },
    {
      name: "a zero share token",
      env: { ...VALID_ENV, TRON_LEND_SHARE_TOKEN: ZERO_ADDRESS },
      error: /TRON_LEND_SHARE_TOKEN is the zero address/,
    },
    {
      name: "a short underlying",
      env: { ...VALID_ENV, TRON_LEND_UNDERLYING: "0x1234" },
      error: /20-byte 0x hex EVM address/,
    },
    {
      name: "one token in both roles, in two forms",
      env: { ...VALID_ENV, TRON_LEND_SHARE_TOKEN: USDT_EVM_FORM },
      error: /name the same token/,
    },
    {
      name: "a share token TRON_TOKEN_FACTORS leaves out",
      env: { ...VALID_ENV, TRON_TOKEN_FACTORS: undefined },
      error: new RegExp(`TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN ${SHARE_TOKEN}`),
    },
    {
      name: "a factor naming only the underlying",
      env: { ...VALID_ENV, TRON_TOKEN_FACTORS: JSON.stringify({ [USDT_BASE58]: "1" }) },
      error: /TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, error }) => {
    expect(() => resolveTronLendPair(env)).toThrow(error);
  });
});

describe("assertTronLendPairListed", () => {
  const PAIR: TronLendPair = {
    underlying: USDT_EVM_FORM,
    shareToken: SHARE_TOKEN,
    minSupply: 1_000_000n,
    shareFactor: SHARE_FACTOR,
  };
  const LISTING: TronTokenListing = {
    fees: { withdraw: 0n, swap: 0n, supply: 0n, redeem: 0n },
    factor: 1n,
  };

  it("admits a pair whose tokens this run lists", () => {
    expect(() => {
      assertTronLendPairListed(
        PAIR,
        new Map([
          [USDT_EVM_FORM, LISTING],
          [SHARE_TOKEN, LISTING],
        ]),
      );
    }).not.toThrow();
  });

  it.each([
    {
      name: "the share token",
      listed: [USDT_EVM_FORM],
      error: `TRON_LEND_SHARE_TOKEN ${SHARE_TOKEN} is not in TRON_ALLOWED_TOKENS, so the pair cannot be set.`,
    },
    {
      name: "the underlying",
      listed: [SHARE_TOKEN],
      error: `TRON_LEND_UNDERLYING ${USDT_EVM_FORM} is not in TRON_ALLOWED_TOKENS, so the pair cannot be set.`,
    },
  ])("refuses a listing that leaves out $name", ({ listed, error }) => {
    expect(() => {
      assertTronLendPairListed(PAIR, new Map(listed.map((token) => [token, LISTING])));
    }).toThrow(error);
  });
});

describe("addAllowedTronTokensToVault", () => {
  it("refuses to list a paired share token TRON_TOKEN_FACTORS leaves out, before any wallet", async () => {
    await expect(
      addAllowedTronTokensToVault({
        ...VALID_ENV,
        TRON_TOKEN_FACTORS: undefined,
        TRON_ALLOWED_TOKENS: `${USDT_BASE58},${SHARE_TOKEN}`,
        MIDNIGHT_VAULT_CONTRACT_ADDRESS: "00".repeat(32),
      }),
    ).rejects.toThrow(`TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN ${SHARE_TOKEN}`);
  });
});
