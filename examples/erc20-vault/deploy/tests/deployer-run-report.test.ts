// The settings table every deployer-wallet run prints: the deploy SDK's
// node-config rows with the vault's own rows after them.

import { DeploySettingSource, getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import { describe, expect, it } from "vitest";

import { deployerRunSettingsTable } from "../src/deployer-run-report.ts";

const LOCAL_ENV = { NETWORK_ID: "undeployed" };

describe("deployerRunSettingsTable", () => {
  it.each([
    {
      name: "a variable set in the environment",
      env: { ...LOCAL_ENV, EVM_CHAIN_ID: "11155111" },
      vaultSettings: { EVM_CHAIN_ID: "11155111" },
      expected: {
        EVM_CHAIN_ID: { value: "11155111", source: DeploySettingSource.Environment },
      },
    },
    {
      name: "a variable the run resolved a built-in value for",
      env: LOCAL_ENV,
      vaultSettings: { VAULT_FEE_SWAP: "1000" },
      expected: { VAULT_FEE_SWAP: { value: "1000", source: DeploySettingSource.Default } },
    },
    {
      name: "a blank variable, which counts as unset",
      env: { ...LOCAL_ENV, VAULT_FEE_SWAP: "  " },
      vaultSettings: { VAULT_FEE_SWAP: "1000" },
      expected: { VAULT_FEE_SWAP: { value: "1000", source: DeploySettingSource.Default } },
    },
    {
      name: "a variable nothing supplies",
      env: LOCAL_ENV,
      vaultSettings: { VAULT_TOKEN_FEES: undefined },
      expected: { VAULT_TOKEN_FEES: { value: "(none)", source: DeploySettingSource.Default } },
    },
    {
      name: "a URL, whose query values are masked",
      env: { ...LOCAL_ENV, EVM_RPC_URL: "https://rpc.example/?key=secret" },
      vaultSettings: { EVM_RPC_URL: "https://rpc.example/?key=secret" },
      expected: {
        EVM_RPC_URL: {
          value: "https://rpc.example/?key=REDACTED",
          source: DeploySettingSource.Environment,
        },
      },
    },
  ])("tabulates $name", ({ env, vaultSettings, expected }) => {
    expect(deployerRunSettingsTable(env, getMidnightNodeConfig(env), vaultSettings)).toMatchObject(
      expected,
    );
  });

  it("lists the node-config rows ahead of the vault's", () => {
    const table = deployerRunSettingsTable(LOCAL_ENV, getMidnightNodeConfig(LOCAL_ENV), {
      EVM_ALLOWED_TOKENS: "",
    });
    expect(Object.keys(table)).toEqual([
      "NETWORK_ID",
      "MIDNIGHT_NODE_URL",
      "MIDNIGHT_NODE_INDEXER_URL",
      "MIDNIGHT_NODE_INDEXER_WS_URL",
      "MIDNIGHT_NODE_PROOF_SERVER_URL",
      "MIDNIGHT_FAUCET_URL",
      "EVM_ALLOWED_TOKENS",
    ]);
  });
});
