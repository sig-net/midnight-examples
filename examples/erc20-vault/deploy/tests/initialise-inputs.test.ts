// The checks a deploy+initialise run makes BEFORE spending the multistage
// deploy: the address-free initialise inputs must parse, and nothing bound to
// a previous vault may be lying around in the environment.

import { describe, expect, it } from "vitest";

import {
  assertInitialiseInputsPresent,
  assertNoVaultBoundPresets,
} from "../src/initialise-vault.ts";

// The smallest environment initialise accepts without an address: the EVM
// targets default to their Sepolia canonicals.
const VALID_INPUTS = {
  MPC_SECP256K1_PUBKEY: "0x04ab",
  EVM_CHAIN_ID: "11155111",
} as const;

describe("assertInitialiseInputsPresent", () => {
  const ACCEPTED_CHAIN_IDS: readonly string[] = ["1", "11155111"];

  it.each(ACCEPTED_CHAIN_IDS)("accepts EVM_CHAIN_ID=%s", (chainId) => {
    expect(() => {
      assertInitialiseInputsPresent({ ...VALID_INPUTS, EVM_CHAIN_ID: chainId });
    }).not.toThrow();
  });

  const REFUSED_CHAIN_IDS: readonly string[] = ["", "0", "00", "007", "-1", "1.5", "abc"];

  it.each(REFUSED_CHAIN_IDS)("refuses EVM_CHAIN_ID=%s", (chainId) => {
    expect(() => {
      assertInitialiseInputsPresent({ ...VALID_INPUTS, EVM_CHAIN_ID: chainId });
    }).toThrow(/EVM_CHAIN_ID/);
  });

  it("requires the MPC public key", () => {
    expect(() => {
      assertInitialiseInputsPresent({ ...VALID_INPUTS, MPC_SECP256K1_PUBKEY: undefined });
    }).toThrow(/MPC_SECP256K1_PUBKEY/);
  });
});

describe("assertNoVaultBoundPresets", () => {
  /** A case the guard accepts: nothing bound to a previous vault is set. */
  interface AcceptedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
  }

  const ACCEPTED: readonly AcceptedCase[] = [
    {
      name: "an environment holding nothing bound to a vault",
      env: { ...VALID_INPUTS, MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "aa".repeat(32) },
    },
    {
      name: "blank lines from an emptied .env",
      env: { ...VALID_INPUTS, EVM_VAULT_ADDRESS: "", MPC_RESPONSE_KEY: "" },
    },
  ];

  it.each(ACCEPTED)("accepts $name", ({ env }) => {
    expect(() => {
      assertNoVaultBoundPresets(env);
    }).not.toThrow();
  });

  /** A case the guard refuses, and every preset name its error must carry. */
  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly named: readonly string[];
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a previous vault's EVM address",
      env: { ...VALID_INPUTS, EVM_VAULT_ADDRESS: `0x${"ab".repeat(20)}` },
      named: ["EVM_VAULT_ADDRESS"],
    },
    {
      name: "a previous vault's response key",
      env: { ...VALID_INPUTS, MPC_RESPONSE_KEY: `04${"cd".repeat(64)}` },
      named: ["MPC_RESPONSE_KEY"],
    },
    {
      name: "a previous vault's contract address",
      env: { ...VALID_INPUTS, MIDNIGHT_VAULT_CONTRACT_ADDRESS: "bb".repeat(32) },
      named: ["MIDNIGHT_VAULT_CONTRACT_ADDRESS"],
    },
    {
      name: "everything a local e2e run appends",
      env: {
        ...VALID_INPUTS,
        MIDNIGHT_VAULT_CONTRACT_ADDRESS: "bb".repeat(32),
        EVM_VAULT_ADDRESS: `0x${"ab".repeat(20)}`,
        MPC_RESPONSE_KEY: `04${"cd".repeat(64)}`,
      },
      named: ["MIDNIGHT_VAULT_CONTRACT_ADDRESS", "EVM_VAULT_ADDRESS", "MPC_RESPONSE_KEY"],
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, named }) => {
    const check = (): void => {
      assertNoVaultBoundPresets(env);
    };
    for (const name of named) expect(check).toThrow(name);
  });
});
