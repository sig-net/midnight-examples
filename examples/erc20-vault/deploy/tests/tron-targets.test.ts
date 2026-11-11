import { describe, expect, it } from "vitest";

import { resolveAllowedTronTokens, resolveTronStartHeight } from "../src/tron-targets.ts";

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_EVM_FORM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const OTHER_TOKEN = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

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
