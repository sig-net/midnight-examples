import type { TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_FEE } from "../src/fee-config.ts";
import {
  assertTronUsdtSealedIfAllowed,
  resolveAllowedTronTokens,
  resolveTronStartHeight,
  resolveTronTokenFactors,
  resolveTronTokenListings,
  resolveTronUsdtAddress,
} from "../src/tron-targets.ts";

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_EVM_FORM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const OTHER_TOKEN = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const NILE_USDT_BASE58 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

describe("resolveAllowedTronTokens", () => {
  interface ResolvedCase {
    readonly name: string;
    readonly listed: string | undefined;
    readonly tokens: readonly string[];
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "an unset list to nothing", listed: undefined, tokens: [] },
    { name: "a blank list to nothing", listed: "  ", tokens: [] },
    { name: "a base58 address to its 20-byte form", listed: USDT_BASE58, tokens: [USDT_EVM_FORM] },
    { name: "a 20-byte hex address", listed: OTHER_TOKEN, tokens: [OTHER_TOKEN] },
    {
      name: "a hex address without its 0x prefix, in upper case",
      listed: OTHER_TOKEN.slice(2).toUpperCase(),
      tokens: [OTHER_TOKEN],
    },
    {
      name: "both forms in listed order",
      listed: ` ${OTHER_TOKEN} , ${USDT_BASE58} ,`,
      tokens: [OTHER_TOKEN, USDT_EVM_FORM],
    },
    {
      name: "the same token in both forms to one entry",
      listed: `${USDT_BASE58},${USDT_EVM_FORM}`,
      tokens: [USDT_EVM_FORM],
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ listed, tokens }) => {
    expect(resolveAllowedTronTokens({ TRON_ALLOWED_TOKENS: listed })).toEqual(tokens);
  });

  interface RefusedCase {
    readonly name: string;
    readonly listed: string;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a base58 address with a bad checksum",
      listed: `${USDT_BASE58.slice(0, -1)}u`,
      error: /checksum|base58/,
    },
    { name: "a short hex address", listed: "0x1234", error: /20-byte 0x hex EVM address/ },
    { name: "the zero address", listed: `0x${"00".repeat(20)}`, error: /zero address/ },
  ];

  it.each(REFUSED)("refuses $name", ({ listed, error }) => {
    expect(() => resolveAllowedTronTokens({ TRON_ALLOWED_TOKENS: listed })).toThrow(error);
  });
});

describe("resolveTronStartHeight", () => {
  it.each([
    { name: "unset with no TRON_RPC_URL to zero", env: {}, height: 0n },
    { name: "a preset height", env: { TRON_START_HEIGHT: "64100" }, height: 64_100n },
    { name: "a preset zero", env: { TRON_START_HEIGHT: "0" }, height: 0n },
  ])("resolves $name", async ({ env, height }) => {
    await expect(resolveTronStartHeight(env)).resolves.toBe(height);
  });

  it.each(["-1", "01", "1.5", "abc"])("refuses TRON_START_HEIGHT=%s", async (preset) => {
    await expect(resolveTronStartHeight({ TRON_START_HEIGHT: preset })).rejects.toThrow(
      /TRON_START_HEIGHT/,
    );
  });
});

describe("resolveTronUsdtAddress", () => {
  it.each([
    { name: "unset to the zero address", value: undefined, address: ZERO_ADDRESS },
    { name: "blank to the zero address", value: "  ", address: ZERO_ADDRESS },
    { name: "mainnet USDT in base58", value: USDT_BASE58, address: USDT_EVM_FORM },
    { name: "a 20-byte hex address", value: USDT_EVM_FORM, address: USDT_EVM_FORM },
    {
      name: "a hex address without its 0x prefix, in upper case",
      value: USDT_EVM_FORM.slice(2).toUpperCase(),
      address: USDT_EVM_FORM,
    },
  ])("resolves $name", ({ value, address }) => {
    expect(resolveTronUsdtAddress({ TRON_USDT_ADDRESS: value })).toBe(address);
  });

  it.each([
    { network: "preprod", base58: NILE_USDT_BASE58 },
    { network: "mainnet", base58: USDT_BASE58 },
  ])("resolves blank on $network to its known USDT", ({ network, base58 }) => {
    const known = resolveTronUsdtAddress({ TRON_USDT_ADDRESS: base58 });
    expect(resolveTronUsdtAddress({ NETWORK_ID: network, TRON_USDT_ADDRESS: " " })).toBe(known);
  });

  it("resolves blank on preview to the zero address", () => {
    expect(resolveTronUsdtAddress({ NETWORK_ID: "preview" })).toBe(ZERO_ADDRESS);
  });

  it("resolves Nile USDT to a 20-byte address", () => {
    expect(resolveTronUsdtAddress({ TRON_USDT_ADDRESS: NILE_USDT_BASE58 })).toMatch(
      /^0x[0-9a-f]{40}$/,
    );
  });

  it.each([
    { name: "a base58 address with a bad checksum", value: `${USDT_BASE58.slice(0, -1)}u` },
    { name: "a short hex address", value: "0x1234" },
  ])("refuses $name", ({ value }) => {
    expect(() => resolveTronUsdtAddress({ TRON_USDT_ADDRESS: value })).toThrow();
  });
});

describe("assertTronUsdtSealedIfAllowed", () => {
  it.each([USDT_BASE58, NILE_USDT_BASE58])("refuses %s allowed with a zero USDT", (base58) => {
    const usdt = resolveTronUsdtAddress({ TRON_USDT_ADDRESS: base58 });
    expect(() => {
      assertTronUsdtSealedIfAllowed([OTHER_TOKEN, usdt], ZERO_ADDRESS);
    }).toThrow(/TRON_USDT_ADDRESS/);
  });

  it.each([
    { name: "a known USDT allowed with USDT sealed", tokens: [USDT_EVM_FORM], usdt: USDT_EVM_FORM },
    { name: "other tokens allowed with a zero USDT", tokens: [OTHER_TOKEN], usdt: ZERO_ADDRESS },
  ])("accepts $name", ({ tokens, usdt }) => {
    expect(() => {
      assertTronUsdtSealedIfAllowed(tokens, usdt);
    }).not.toThrow();
  });
});

describe("resolveTronTokenFactors", () => {
  interface ResolvedCase {
    readonly name: string;
    readonly factors: string | undefined;
    readonly expected: ReadonlyMap<string, bigint>;
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "unset to no factor", factors: undefined, expected: new Map() },
    { name: "blank to no factor", factors: " ", expected: new Map() },
    {
      name: "a base58 key to its 20-byte form, with a string factor",
      factors: JSON.stringify({ [USDT_BASE58]: "1000000000000" }),
      expected: new Map([[USDT_EVM_FORM, 1_000_000_000_000n]]),
    },
    {
      name: "a hex key without 0x in upper case, with a number factor",
      factors: JSON.stringify({ [OTHER_TOKEN.slice(2).toUpperCase()]: 1 }),
      expected: new Map([[OTHER_TOKEN, 1n]]),
    },
    {
      name: "the Uint<64> maximum",
      factors: JSON.stringify({ [OTHER_TOKEN]: "18446744073709551615" }),
      expected: new Map([[OTHER_TOKEN, 2n ** 64n - 1n]]),
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ factors, expected }) => {
    expect(resolveTronTokenFactors({ TRON_TOKEN_FACTORS: factors })).toEqual(expected);
  });

  interface RefusedCase {
    readonly name: string;
    readonly factors: string;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    { name: "a value that is not JSON", factors: "{", error: /must be a JSON object/ },
    { name: "a JSON array", factors: "[]", error: /must be a JSON object/ },
    {
      name: "a zero factor",
      factors: JSON.stringify({ [OTHER_TOKEN]: "0" }),
      error: /must be a positive integer, got "0"/,
    },
    {
      name: "a negative factor",
      factors: JSON.stringify({ [OTHER_TOKEN]: -1 }),
      error: /must be a positive integer, got "-1"/,
    },
    {
      name: "a fractional factor",
      factors: JSON.stringify({ [OTHER_TOKEN]: 1.5 }),
      error: /must be an integer, got 1.5/,
    },
    {
      name: "a factor wider than Uint<64>",
      factors: JSON.stringify({ [OTHER_TOKEN]: "18446744073709551616" }),
      error: /must fit a Uint<64>/,
    },
    {
      name: "a factor that is neither a string nor a number",
      factors: JSON.stringify({ [OTHER_TOKEN]: true }),
      error: /as a string or a number/,
    },
    {
      name: "the zero address",
      factors: JSON.stringify({ [ZERO_ADDRESS]: "1" }),
      error: /zero address/,
    },
    {
      name: "one token named in both forms",
      factors: JSON.stringify({ [USDT_BASE58]: "1", [USDT_EVM_FORM]: "1" }),
      error: /names 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c twice/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ factors, error }) => {
    expect(() => resolveTronTokenFactors({ TRON_TOKEN_FACTORS: factors })).toThrow(error);
  });
});

describe("resolveTronTokenListings", () => {
  const LOCAL_FEES: TokenFees = {
    withdraw: DEFAULT_TOKEN_FEE,
    swap: DEFAULT_TOKEN_FEE,
    supply: DEFAULT_TOKEN_FEE,
    redeem: DEFAULT_TOKEN_FEE,
  };

  it("lists each token with its fees, its named factor, and factor 1 when unnamed", () => {
    const env = {
      TRON_ALLOWED_TOKENS: `${USDT_BASE58},${OTHER_TOKEN}`,
      TRON_TOKEN_FACTORS: JSON.stringify({ [OTHER_TOKEN]: "1000000000000" }),
      VAULT_TOKEN_FEES: JSON.stringify({
        [USDT_EVM_FORM]: { withdraw: "5", swap: "0", supply: "6", redeem: "7" },
      }),
    };
    expect(resolveTronTokenListings(env)).toEqual(
      new Map([
        [USDT_EVM_FORM, { fees: { withdraw: 5n, swap: 0n, supply: 6n, redeem: 7n }, factor: 1n }],
        [OTHER_TOKEN, { fees: LOCAL_FEES, factor: 1_000_000_000_000n }],
      ]),
    );
  });

  it("refuses a factor naming a token the list leaves out", () => {
    const env = {
      TRON_ALLOWED_TOKENS: USDT_BASE58,
      TRON_TOKEN_FACTORS: JSON.stringify({ [OTHER_TOKEN]: "1000000000000" }),
    };
    expect(() => resolveTronTokenListings(env)).toThrow(
      `TRON_TOKEN_FACTORS names ${OTHER_TOKEN}, which TRON_ALLOWED_TOKENS does not list.`,
    );
  });

  it("refuses a list naming the lend share token without its factor", () => {
    const env = {
      TRON_ALLOWED_TOKENS: `${USDT_BASE58},${OTHER_TOKEN}`,
      TRON_LEND_SHARE_TOKEN: OTHER_TOKEN,
      TRON_TOKEN_FACTORS: JSON.stringify({ [USDT_BASE58]: "1" }),
    };
    expect(() => resolveTronTokenListings(env)).toThrow(
      `TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN ${OTHER_TOKEN}`,
    );
  });

  it("lists other tokens without the lend share token's factor", () => {
    const env = { TRON_ALLOWED_TOKENS: USDT_BASE58, TRON_LEND_SHARE_TOKEN: OTHER_TOKEN };
    expect(resolveTronTokenListings(env)).toEqual(
      new Map([[USDT_EVM_FORM, { fees: LOCAL_FEES, factor: 1n }]]),
    );
  });

  it("lists nothing for an unset list, whatever factors are named", () => {
    const env = { TRON_TOKEN_FACTORS: JSON.stringify({ [OTHER_TOKEN]: "10" }) };
    expect(resolveTronTokenListings(env)).toEqual(new Map());
  });
});
