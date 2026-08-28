// The guard standing between a local e2e run's leftovers and a remote deploy.
// The e2e setup appends MPC_ROOT_PRIVATE_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS to
// the repo-root .env on every local run, and the vault's constructor seals the
// signet address permanently, so a stagenet deploy that silently picked those
// up would produce a contract that can never work.

import { describe, expect, it } from "vitest";

import { assertEnvFileMatchesNetwork } from "../src/entrypoint-env.ts";

// What a local e2e run leaves in the repo-root .env.
const LOCAL_ENV_FILE = {
  MIDNIGHT_ROOT_WALLET_SEED: "00".repeat(32),
  MPC_ROOT_PRIVATE_KEY: "123456",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "aa".repeat(32),
  MIDNIGHT_VAULT_CONTRACT_ADDRESS: "bb".repeat(32),
  MPC_ROOT_PUBLIC_KEY: "0x04ab",
} as const;

/** A case: what the file holds, what the shell exports, the network targeted. */
interface GuardCase {
  readonly name: string;
  readonly fileEnv: Record<string, string | undefined>;
  readonly processEnv: Record<string, string | undefined>;
  readonly networkId: "undeployed" | "stagenet";
}

const ACCEPTED: readonly GuardCase[] = [
  {
    name: "a local run against the local values that produced it",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: {},
    networkId: "undeployed",
  },
  {
    name: "a remote run overriding every network-scoped value it inherits",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: {
      MIDNIGHT_NETWORK_ID: "stagenet",
      MPC_ROOT_PRIVATE_KEY: "999",
      MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "cc".repeat(32),
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "dd".repeat(32),
      MPC_ROOT_PUBLIC_KEY: "0x04cd",
    },
    networkId: "stagenet",
  },
  {
    name: "a remote run whose file carries only network-agnostic values",
    fileEnv: {
      MIDNIGHT_ROOT_WALLET_SEED: LOCAL_ENV_FILE.MIDNIGHT_ROOT_WALLET_SEED,
      FUND_WALLET_NIGHT_AMOUNT: "1000",
    },
    processEnv: { MIDNIGHT_NETWORK_ID: "stagenet" },
    networkId: "stagenet",
  },
  {
    name: "a blank value in the file, which counts as unset",
    fileEnv: { MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "   " },
    processEnv: { MIDNIGHT_NETWORK_ID: "stagenet" },
    networkId: "stagenet",
  },
];

/** A refused case, plus the variables its error must name. */
interface RefusedCase extends GuardCase {
  readonly names: readonly string[];
}

const REFUSED: readonly RefusedCase[] = [
  {
    name: "a remote run inheriting the local run's network-scoped values",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: { MIDNIGHT_NETWORK_ID: "stagenet" },
    networkId: "stagenet",
    names: [
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
      "MPC_ROOT_PRIVATE_KEY",
      "MPC_ROOT_PUBLIC_KEY",
      "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
    ],
  },
  {
    name: "a local run against a file pinned to a remote network",
    fileEnv: { ...LOCAL_ENV_FILE, MIDNIGHT_NETWORK_ID: "stagenet" },
    processEnv: {},
    networkId: "undeployed",
    names: ["MIDNIGHT_SIGNET_CONTRACT_ADDRESS"],
  },
  {
    name: "a remote run overriding only some of what it inherits",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: {
      MIDNIGHT_NETWORK_ID: "stagenet",
      MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "cc".repeat(32),
    },
    networkId: "stagenet",
    names: ["MPC_ROOT_PRIVATE_KEY"],
  },
];

describe("assertEnvFileMatchesNetwork", () => {
  it.each(ACCEPTED)("accepts $name", ({ fileEnv, processEnv, networkId }) => {
    expect(() => {
      assertEnvFileMatchesNetwork(fileEnv, processEnv, networkId);
    }).not.toThrow();
  });

  it.each(REFUSED)("refuses $name", ({ fileEnv, processEnv, networkId, names }) => {
    const check = (): void => {
      assertEnvFileMatchesNetwork(fileEnv, processEnv, networkId);
    };
    expect(check).toThrow(new RegExp(names.join("|")));
    // The error names every stale variable, so one run fixes them all.
    expect(names.every((name) => String(getError(check)).includes(name))).toBe(true);
  });
});

// The error a throwing call produced, for assertions about its whole message.
function getError(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
