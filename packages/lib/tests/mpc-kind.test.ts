// Which MPC a run faces, from the root key and the network alone.

import { describe, expect, it } from "vitest";

import { MpcKind, mpcKind } from "../src/mpc-kind.ts";

const ROOT_KEY = `0x${"00".repeat(31)}01`;

interface ResolvedCase {
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly expected: MpcKind;
}

const RESOLVED: readonly ResolvedCase[] = [
  {
    name: "a root key on the local stack",
    env: { NETWORK_ID: "undeployed", MPC_ROOT_KEY: ROOT_KEY },
    expected: MpcKind.Fakenet,
  },
  {
    name: "a root key on a deployed network (a fakenet answering that network)",
    env: { NETWORK_ID: "stagenet", MPC_ROOT_KEY: ROOT_KEY },
    expected: MpcKind.Fakenet,
  },
  {
    name: "no root key on a deployed network",
    env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: "0x04ab" },
    expected: MpcKind.Real,
  },
];

describe("mpcKind", () => {
  it.each(RESOLVED)("resolves $name", ({ env, expected }) => {
    expect(mpcKind(env)).toBe(expected);
  });

  const REFUSED: readonly NodeJS.ProcessEnv[] = [
    { NETWORK_ID: "undeployed" },
    { NETWORK_ID: "undeployed", MPC_SECP256K1_PUBKEY: "0x04ab" },
    {},
  ];

  it.each(REFUSED)("refuses the local stack without a root key: %o", (env) => {
    expect(() => mpcKind(env)).toThrow(/no MPC_ROOT_KEY on the local/);
  });
});
