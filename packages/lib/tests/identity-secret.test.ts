// identitySecretFromSeed: wallet seed → 32-byte identity secret. Pure — no network.

import { describe, expect, it } from "vitest";

import { identitySecretFromSeed, ParseError } from "../src/index.ts";

const SEED_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

// A valid 24-word BIP-39 mnemonic (all-zero entropy test vector); its PBKDF2
// seed is 64 bytes, so it can never double as a 32-byte identity secret.
const MNEMONIC_24_WORDS =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const bytesOf = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

interface Case {
  name: string;
  seed: string;
  expected: Uint8Array;
}

const CASES: Case[] = [
  {
    name: "a 32-byte hex seed's bytes ARE the identity secret",
    seed: SEED_HEX,
    expected: bytesOf(SEED_HEX),
  },
  {
    name: "0x prefix and padding are normalised",
    seed: `  0x${SEED_HEX}  `,
    expected: bytesOf(SEED_HEX),
  },
];

describe("identitySecretFromSeed", () => {
  it.each(CASES)("$name", ({ seed, expected }) => {
    expect(identitySecretFromSeed(seed)).toEqual(expected);
  });

  it("rejects a seed that does not parse to exactly 32 bytes", () => {
    // 16 bytes is a valid wallet seed but too short for an identity secret.
    expect(() => identitySecretFromSeed("00000000000000000000000000000001")).toThrow(ParseError);
  });

  it("rejects a mnemonic (it expands to a 64-byte seed)", () => {
    expect(() => identitySecretFromSeed(MNEMONIC_24_WORDS)).toThrow(ParseError);
  });

  it("rejects non-seed input with parseSeed's own error", () => {
    expect(() => identitySecretFromSeed("not hex, not a mnemonic")).toThrow(ParseError);
  });
});
