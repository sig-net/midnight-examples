// How EVM_ALLOWED_TOKENS resolves into the ERC20s the deployer allows after
// initialise. Offline: resolution only parses the environment.

import { describe, expect, it } from "vitest";

import { resolveAllowedTokens } from "../src/evm-targets.ts";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const EURC = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";

describe("resolveAllowedTokens", () => {
  /** An EVM_ALLOWED_TOKENS value and the tokens it resolves to. */
  interface ResolvedCase {
    readonly name: string;
    readonly listed: string | undefined;
    readonly tokens: readonly string[];
  }

  const RESOLVED: readonly ResolvedCase[] = [
    { name: "an unset list to nothing", listed: undefined, tokens: [] },
    { name: "a blank list to nothing", listed: "  ", tokens: [] },
    { name: "one token", listed: USDC, tokens: [USDC] },
    { name: "two tokens in listed order", listed: `${EURC},${USDC}`, tokens: [EURC, USDC] },
    { name: "entries padded with spaces", listed: ` ${USDC} , ${EURC} `, tokens: [USDC, EURC] },
    { name: "empty entries to nothing", listed: `${USDC},,${EURC},`, tokens: [USDC, EURC] },
    { name: "an entry without its 0x prefix", listed: USDC.slice(2), tokens: [USDC] },
    {
      name: "a repeat in another case to its first spelling",
      listed: `${USDC},${USDC.toLowerCase()}`,
      tokens: [USDC],
    },
  ];

  it.each(RESOLVED)("resolves $name", ({ listed, tokens }) => {
    expect(resolveAllowedTokens({ EVM_ALLOWED_TOKENS: listed })).toEqual(tokens);
  });

  /** An EVM_ALLOWED_TOKENS value resolution refuses, and the refusal. */
  interface RefusedCase {
    readonly name: string;
    readonly listed: string;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    { name: "a short address", listed: "0x1234", error: /20-byte 0x hex EVM address/ },
    { name: "a non-hex address", listed: `0x${"zz".repeat(20)}`, error: /20-byte 0x hex/ },
    {
      name: "the zero address among valid ones",
      listed: `${USDC},0x${"00".repeat(20)}`,
      error: /zero address/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ listed, error }) => {
    expect(() => resolveAllowedTokens({ EVM_ALLOWED_TOKENS: listed })).toThrow(error);
  });
});
