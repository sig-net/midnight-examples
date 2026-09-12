// The checks a deploy+initialise run makes BEFORE spending the multistage
// deploy: the address-free initialise inputs must resolve, and nothing bound to
// a previous vault may be lying around in the environment. Offline: every case
// pins EVM_CHAIN_ID or omits EVM_RPC_URL, so no chain is consulted.

import { describe, expect, it } from "vitest";

import {
  assertInitialiseInputsPresent,
  assertNoVaultBoundPresets,
} from "../src/initialise-vault.ts";

// The stagenet MPC root public key as the MPC team hands it out (NEAR form),
// its canonical SEC1 spelling, and its compressed twin.
const MPC_KEY_NEAR_FORM =
  "secp256k1:54hU5wcCmVUPFWLDALXMh1fFToZsVXrx9BbTbHzSfQq1Kd1rJZi52iPa4QQxo6s5TgjWqgpY8HamYuUDzG6fAaUq";
const MPC_KEY_CANONICAL =
  "0x04cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61ca3e59da1c194aa90108098a9e5cdc55d3b3297cdefbc085ffafd0f2c34ae61a";
const MPC_KEY_COMPRESSED = "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61";

// The smallest environment initialise accepts without an address on the local
// stack (which publishes no MPC key): the EVM targets default to their Sepolia
// canonicals.
const VALID_INPUTS = {
  MPC_SECP256K1_PUBKEY: MPC_KEY_CANONICAL,
  EVM_CHAIN_ID: "11155111",
} as const;

describe("assertInitialiseInputsPresent", () => {
  /** An environment the check accepts. */
  interface AcceptedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
  }

  const ACCEPTED: readonly AcceptedCase[] = [
    {
      name: "the NEAR form of the MPC key",
      env: { ...VALID_INPUTS, MPC_SECP256K1_PUBKEY: MPC_KEY_NEAR_FORM },
    },
    { name: "the canonical MPC key", env: VALID_INPUTS },
    {
      name: "the compressed MPC key",
      env: { ...VALID_INPUTS, MPC_SECP256K1_PUBKEY: MPC_KEY_COMPRESSED },
    },
    {
      name: "no MPC key on a deployed network the SDK publishes one for",
      env: { NETWORK_ID: "stagenet", EVM_CHAIN_ID: "11155111" },
    },
    { name: "chain id 1", env: { ...VALID_INPUTS, EVM_CHAIN_ID: "1" } },
  ];

  it.each(ACCEPTED)("accepts $name", async ({ env }) => {
    await expect(assertInitialiseInputsPresent(env)).resolves.toBeUndefined();
  });

  /** An environment the check refuses, and the refusal. */
  interface RefusedCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly error: RegExp;
  }

  const REFUSED_CHAIN_IDS: readonly RefusedCase[] = ["", "0", "00", "007", "-1", "1.5", "abc"].map(
    (chainId) => ({
      name: `EVM_CHAIN_ID=${chainId}`,
      env: { ...VALID_INPUTS, EVM_CHAIN_ID: chainId },
      error: /EVM_CHAIN_ID/,
    }),
  );

  const REFUSED: readonly RefusedCase[] = [
    ...REFUSED_CHAIN_IDS,
    {
      name: "an MPC key that is not a secp256k1 public key",
      env: { ...VALID_INPUTS, MPC_SECP256K1_PUBKEY: "0x04ab" },
      error: /not a secp256k1 public key/,
    },
    {
      name: "no MPC key on the local stack, which publishes none",
      env: { ...VALID_INPUTS, MPC_SECP256K1_PUBKEY: undefined },
      error: /MPC_SECP256K1_PUBKEY is required on "undeployed"/,
    },
    {
      name: "an MPC key disagreeing with the one the SDK publishes for the network",
      env: {
        NETWORK_ID: "stagenet",
        EVM_CHAIN_ID: "11155111",
        MPC_SECP256K1_PUBKEY:
          "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      },
      error: /disagrees with the MPC root public key the SDK publishes/,
    },
    {
      name: "neither a chain id nor an RPC to read it from",
      env: { MPC_SECP256K1_PUBKEY: MPC_KEY_CANONICAL },
      error: /EVM_CHAIN_ID or EVM_RPC_URL is required/,
    },
  ];

  it.each(REFUSED)("refuses $name", async ({ env, error }) => {
    await expect(assertInitialiseInputsPresent(env)).rejects.toThrow(error);
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
