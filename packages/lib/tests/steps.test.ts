// The setup steps testable without a stack: which MPC a run faces (fakenet
// root key held, or a real MPC named by its public key) and the one node
// rejection the steps translate (which errors get the stack-reset hint, and
// that every other error passes through untouched).

import { describe, expect, it } from "vitest";

import {
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  explainDustSpendRejection,
} from "../src/steps.ts";

// The secp256k1 generator point: the public key of root key 1, in the
// canonical spelling the steps write.
const GENERATOR_UNCOMPRESSED =
  "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const GENERATOR_COMPRESSED = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const ROOT_KEY_ONE = `0x${"00".repeat(31)}01`;
// The stagenet MPC root public key as the MPC team hands it out (NEAR form)
// and its canonical spelling.
const STAGENET_NEAR_FORM =
  "secp256k1:54hU5wcCmVUPFWLDALXMh1fFToZsVXrx9BbTbHzSfQq1Kd1rJZi52iPa4QQxo6s5TgjWqgpY8HamYuUDzG6fAaUq";
const STAGENET_CANONICAL =
  "0x04cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61ca3e59da1c194aa90108098a9e5cdc55d3b3297cdefbc085ffafd0f2c34ae61a";

describe("ensureMpcRootKey", () => {
  it("keeps a held root key", () => {
    const env: NodeJS.ProcessEnv = { NETWORK_ID: "undeployed", MPC_ROOT_KEY: ROOT_KEY_ONE };
    ensureMpcRootKey(env);
    expect(env.MPC_ROOT_KEY).toBe(ROOT_KEY_ONE);
  });

  it("generates a root key when nothing names an MPC", () => {
    const env: NodeJS.ProcessEnv = { NETWORK_ID: "undeployed" };
    ensureMpcRootKey(env);
    expect(env.MPC_ROOT_KEY).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("generates no root key beside a preset public key on a deployed network (a real MPC)", () => {
    const env: NodeJS.ProcessEnv = {
      NETWORK_ID: "stagenet",
      MPC_SECP256K1_PUBKEY: STAGENET_NEAR_FORM,
    };
    ensureMpcRootKey(env);
    expect(env.MPC_ROOT_KEY).toBeUndefined();
  });

  it("refuses a preset public key without a root key on the local stack (no real MPC there)", () => {
    const env: NodeJS.ProcessEnv = {
      NETWORK_ID: "undeployed",
      MPC_SECP256K1_PUBKEY: STAGENET_NEAR_FORM,
    };
    expect(() => {
      ensureMpcRootKey(env);
    }).toThrow(/without MPC_ROOT_KEY on the local/);
  });
});

describe("ensureMpcSecp256k1Pubkey", () => {
  interface Case {
    readonly name: string;
    readonly env: NodeJS.ProcessEnv;
    readonly expected: string;
  }

  const CANONICALISED: readonly Case[] = [
    {
      name: "derives the key from a held root key",
      env: { NETWORK_ID: "undeployed", MPC_ROOT_KEY: ROOT_KEY_ONE },
      expected: GENERATOR_UNCOMPRESSED,
    },
    {
      name: "accepts a compressed preset agreeing with the root key, canonicalised",
      env: {
        NETWORK_ID: "undeployed",
        MPC_ROOT_KEY: ROOT_KEY_ONE,
        MPC_SECP256K1_PUBKEY: GENERATOR_COMPRESSED,
      },
      expected: GENERATOR_UNCOMPRESSED,
    },
    {
      name: "canonicalises a NEAR-form preset without a root key (a real MPC)",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: STAGENET_NEAR_FORM },
      expected: STAGENET_CANONICAL,
    },
    {
      name: "keeps a canonical preset without a root key",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: STAGENET_CANONICAL },
      expected: STAGENET_CANONICAL,
    },
    {
      name: "takes the SDK's published key for a deployed network when nothing is preset",
      env: { NETWORK_ID: "stagenet" },
      expected: STAGENET_CANONICAL,
    },
  ];

  it.each(CANONICALISED)("$name", ({ env, expected }) => {
    const accumulator = { ...env };
    ensureMpcSecp256k1Pubkey(accumulator);
    expect(accumulator.MPC_SECP256K1_PUBKEY).toBe(expected);
  });

  interface RefusedCase {
    readonly name: string;
    readonly env: NodeJS.ProcessEnv;
    readonly error: RegExp;
  }

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a preset disagreeing with the held root key",
      env: {
        NETWORK_ID: "undeployed",
        MPC_ROOT_KEY: ROOT_KEY_ONE,
        MPC_SECP256K1_PUBKEY: STAGENET_CANONICAL,
      },
      error: /should be derived from MPC_ROOT_KEY/,
    },
    {
      name: "a malformed preset",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: "0x04abcd" },
      error: /not a secp256k1 public key/,
    },
    {
      name: "no root key, no preset and nothing published for the network",
      env: { NETWORK_ID: "preview" },
      error: /no MPC to face/,
    },
    {
      name: "a preset disagreeing with the SDK's published key for the network",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: GENERATOR_UNCOMPRESSED },
      error: /disagrees with the MPC root public key the SDK publishes/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, error }) => {
    expect(() => {
      ensureMpcSecp256k1Pubkey({ ...env });
    }).toThrow(error);
  });
});

describe("explainDustSpendRejection", () => {
  it("returns what the action resolves to", async () => {
    await expect(explainDustSpendRejection("step", () => Promise.resolve(42))).resolves.toBe(42);
  });

  const EXPLAINED: readonly string[] = [
    "1010: Invalid Transaction: Custom error: 170",
    "submission failed: Custom error: 170",
    "InvalidDustSpendProof",
  ];

  it.each(EXPLAINED)("wraps %j with the stack-reset hint, keeping the cause", async (text) => {
    const original = new Error(text);
    const wrapped = await explainDustSpendRejection("deploy", () => Promise.reject(original)).catch(
      (error: unknown) => error,
    );
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(original);
    expect((wrapped as Error).message).toContain("deploy: node rejected the dust spend");
    expect((wrapped as Error).message).toContain(text);
    expect((wrapped as Error).cause).toBe(original);
  });

  const PASSED_THROUGH: readonly string[] = [
    "wallet holds 1010 NIGHT",
    "connect ECONNREFUSED 127.0.0.1:1010",
    "timed out waiting for block 1010",
    "Custom error: 171",
    "insufficient funds",
  ];

  it.each(PASSED_THROUGH)("rethrows %j as the same object", async (text) => {
    const original = new Error(text);
    const thrown = await explainDustSpendRejection("deploy", () => Promise.reject(original)).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBe(original);
  });
});
