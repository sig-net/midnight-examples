// How the gas variables resolve into the settings setGasParams stores. Offline:
// resolution only parses the environment against the settings it is given.

import { describe, expect, it } from "vitest";

import {
  formatVaultGasParams,
  resolveVaultGasParams,
  type VaultGasParams,
} from "../src/set-gas-params.ts";

const CURRENT: VaultGasParams = {
  maxFeePerGas: 150_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  gasLimits: {
    withdraw: 100_000n,
    approve: 100_000n,
    swap: 700_000n,
    supply: 500_000n,
    redeem: 500_000n,
  },
};

describe("resolveVaultGasParams", () => {
  /** A gas environment and the settings it resolves to. */
  interface ResolvedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly expected: VaultGasParams;
  }

  it.each<ResolvedCase>([
    { name: "keeps every setting when nothing is set", env: {}, expected: CURRENT },
    {
      name: "keeps a setting whose variable is blank",
      env: { VAULT_GAS_LIMIT_WITHDRAW: "" },
      expected: CURRENT,
    },
    {
      name: "replaces only the limits that are set",
      env: { VAULT_GAS_LIMIT_WITHDRAW: "200000", VAULT_GAS_LIMIT_APPROVE: "210000" },
      expected: {
        ...CURRENT,
        gasLimits: { ...CURRENT.gasLimits, withdraw: 200_000n, approve: 210_000n },
      },
    },
    {
      name: "replaces every setting",
      env: {
        VAULT_MAX_FEE_PER_GAS: "9",
        VAULT_MAX_PRIORITY_FEE_PER_GAS: "8",
        VAULT_GAS_LIMIT_WITHDRAW: "1",
        VAULT_GAS_LIMIT_APPROVE: "2",
        VAULT_GAS_LIMIT_SWAP: "3",
        VAULT_GAS_LIMIT_SUPPLY: "4",
        VAULT_GAS_LIMIT_REDEEM: "5",
      },
      expected: {
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 8n,
        gasLimits: { withdraw: 1n, approve: 2n, swap: 3n, supply: 4n, redeem: 5n },
      },
    },
    {
      name: "accepts the widest limit and fee the circuit takes",
      env: {
        VAULT_GAS_LIMIT_SWAP: "18446744073709551615",
        VAULT_MAX_FEE_PER_GAS: "340282366920938463463374607431768211455",
      },
      expected: {
        ...CURRENT,
        maxFeePerGas: 2n ** 128n - 1n,
        gasLimits: { ...CURRENT.gasLimits, swap: 2n ** 64n - 1n },
      },
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveVaultGasParams(env, CURRENT)).toEqual(expected);
  });

  /** A gas environment and the error it is refused with. */
  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly error: string;
  }

  it.each<RefusedCase>([
    {
      name: "refuses a zero limit",
      env: { VAULT_GAS_LIMIT_WITHDRAW: "0" },
      error: 'VAULT_GAS_LIMIT_WITHDRAW must be a positive integer, got "0".',
    },
    {
      name: "refuses a negative limit",
      env: { VAULT_GAS_LIMIT_APPROVE: "-1" },
      error: 'VAULT_GAS_LIMIT_APPROVE must be a positive integer, got "-1".',
    },
    {
      name: "refuses a fractional limit",
      env: { VAULT_GAS_LIMIT_SWAP: "1.5" },
      error: 'VAULT_GAS_LIMIT_SWAP must be a positive integer, got "1.5".',
    },
    {
      name: "refuses a hex fee",
      env: { VAULT_MAX_FEE_PER_GAS: "0x10" },
      error: 'VAULT_MAX_FEE_PER_GAS must be a positive integer, got "0x10".',
    },
    {
      name: "refuses a limit wider than Uint<64>",
      env: { VAULT_GAS_LIMIT_REDEEM: "18446744073709551616" },
      error:
        "VAULT_GAS_LIMIT_REDEEM must be at most 18446744073709551615, got 18446744073709551616.",
    },
    {
      name: "refuses a priority fee above the total fee it is set with",
      env: { VAULT_MAX_FEE_PER_GAS: "5", VAULT_MAX_PRIORITY_FEE_PER_GAS: "6" },
      error: "VAULT_MAX_PRIORITY_FEE_PER_GAS (6) cannot exceed VAULT_MAX_FEE_PER_GAS (5).",
    },
    {
      name: "refuses a total fee below the priority fee the vault keeps",
      env: { VAULT_MAX_FEE_PER_GAS: "999999999" },
      error:
        "VAULT_MAX_PRIORITY_FEE_PER_GAS (1000000000) cannot exceed VAULT_MAX_FEE_PER_GAS (999999999).",
    },
  ])("$name", ({ env, error }) => {
    expect(() => resolveVaultGasParams(env, CURRENT)).toThrow(error);
  });
});

describe("formatVaultGasParams", () => {
  it("renders the fee envelope then every limit", () => {
    expect(formatVaultGasParams(CURRENT)).toBe(
      "max fee 150000000000 wei, max priority fee 1000000000 wei, gas limits " +
        "withdraw 100000, approve 100000, swap 700000, supply 500000, redeem 500000",
    );
  });
});
