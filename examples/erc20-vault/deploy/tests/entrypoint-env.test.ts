// The guard standing between a local e2e run's leftovers and a remote deploy.
// The e2e setup appends MPC_ROOT_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS to
// the repo-root .env on every local run, and the vault's constructor seals the
// signet address permanently, so a stagenet deploy that silently picked those
// up would produce a contract that can never work.

import { MidnightNetwork } from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import { assertEnvFileMatchesNetwork } from "../src/entrypoint-env.ts";

// What a local e2e run leaves in the repo-root .env.
const LOCAL_ENV_FILE = {
  ROOT_SEED: "00".repeat(32),
  MPC_ROOT_KEY: "123456",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "aa".repeat(32),
  MIDNIGHT_VAULT_CONTRACT_ADDRESS: "bb".repeat(32),
  MPC_SECP256K1_PUBKEY: "0x04ab",
} as const;

/** A case: what the file holds, what the shell exports, the network targeted. */
interface GuardCase {
  readonly name: string;
  readonly fileEnv: Record<string, string | undefined>;
  readonly processEnv: Record<string, string | undefined>;
  readonly networkId: MidnightNetwork;
}

const ACCEPTED: readonly GuardCase[] = [
  {
    name: "a local run against the local values that produced it",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: {},
    networkId: MidnightNetwork.Undeployed,
  },
  {
    name: "a remote run overriding both sealed inputs, whatever else the file holds",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: {
      NETWORK_ID: "stagenet",
      MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "cc".repeat(32),
      MPC_SECP256K1_PUBKEY: "0x04cd",
    },
    networkId: MidnightNetwork.Stagenet,
  },
  {
    name: "a remote run inheriting only values no entrypoint seals",
    fileEnv: {
      MPC_ROOT_KEY: LOCAL_ENV_FILE.MPC_ROOT_KEY,
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: LOCAL_ENV_FILE.MIDNIGHT_VAULT_CONTRACT_ADDRESS,
      EVM_VAULT_ADDRESS: `0x${"ab".repeat(20)}`,
      MPC_RESPONSE_KEY: `04${"cd".repeat(64)}`,
    },
    processEnv: { NETWORK_ID: "stagenet" },
    networkId: MidnightNetwork.Stagenet,
  },
  {
    name: "a remote run whose file carries only network-agnostic values",
    fileEnv: { ROOT_SEED: LOCAL_ENV_FILE.ROOT_SEED, FUND_CHILD_NIGHT: "1000" },
    processEnv: { NETWORK_ID: "stagenet" },
    networkId: MidnightNetwork.Stagenet,
  },
  {
    name: "a blank value in the file, which counts as unset",
    fileEnv: { MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "   " },
    processEnv: { NETWORK_ID: "stagenet" },
    networkId: MidnightNetwork.Stagenet,
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
    processEnv: { NETWORK_ID: "stagenet" },
    networkId: MidnightNetwork.Stagenet,
    names: ["MIDNIGHT_SIGNET_CONTRACT_ADDRESS", "MPC_SECP256K1_PUBKEY"],
  },
  {
    name: "a local run against a file pinned to a remote network",
    fileEnv: { ...LOCAL_ENV_FILE, NETWORK_ID: "stagenet" },
    processEnv: {},
    networkId: MidnightNetwork.Undeployed,
    names: ["MIDNIGHT_SIGNET_CONTRACT_ADDRESS"],
  },
  {
    name: "a remote run overriding only some of what it inherits",
    fileEnv: LOCAL_ENV_FILE,
    processEnv: { NETWORK_ID: "stagenet", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "cc".repeat(32) },
    networkId: MidnightNetwork.Stagenet,
    names: ["MPC_SECP256K1_PUBKEY"],
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
    // The error names every stale variable, so one run fixes them all.
    for (const name of names) expect(check).toThrow(name);
  });
});
