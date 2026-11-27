// The setup's guard on a kept vault: a vault notifies only the signet signer
// sealed into it, so the setup must not deploy a second signer beside it.

import { describe, expect, it } from "vitest";

import { assertKeptVaultNamesItsSigner } from "../src/setup.ts";

const VAULT_ADDRESS = "bb".repeat(32);
const SIGNER_ADDRESS = "aa".repeat(32);

describe("assertKeptVaultNamesItsSigner", () => {
  interface AcceptedCase {
    name: string;
    env: NodeJS.ProcessEnv;
  }

  const ACCEPTED: readonly AcceptedCase[] = [
    { name: "a fresh run naming neither contract", env: { NETWORK_ID: "undeployed" } },
    {
      name: "a kept vault beside its signer",
      env: {
        NETWORK_ID: "undeployed",
        MIDNIGHT_VAULT_CONTRACT_ADDRESS: VAULT_ADDRESS,
        MIDNIGHT_SIGNER_CONTRACT_ADDRESS: SIGNER_ADDRESS,
      },
    },
    {
      name: "a kept vault on a network the SDK publishes a signer for",
      env: { NETWORK_ID: "preview", MIDNIGHT_VAULT_CONTRACT_ADDRESS: VAULT_ADDRESS },
    },
    {
      name: "a blank vault address, which counts as unset",
      env: { NETWORK_ID: "undeployed", MIDNIGHT_VAULT_CONTRACT_ADDRESS: "" },
    },
  ];

  it.each(ACCEPTED)("accepts $name", ({ env }) => {
    expect(() => {
      assertKeptVaultNamesItsSigner(env);
    }).not.toThrow();
  });

  it("refuses a kept vault with no signer named", () => {
    expect(() => {
      assertKeptVaultNamesItsSigner({
        NETWORK_ID: "undeployed",
        MIDNIGHT_VAULT_CONTRACT_ADDRESS: VAULT_ADDRESS,
      });
    }).toThrow(
      /MIDNIGHT_VAULT_CONTRACT_ADDRESS is set \(b+\) but MIDNIGHT_SIGNER_CONTRACT_ADDRESS is not/,
    );
  });
});
