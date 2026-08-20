// getDeployConfig: env → DeployConfig parsing. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import { getDeployConfig, type NetworkId } from "../src/index.ts";

// The pre-funded genesis mint wallet of the local standalone stack — the
// documented default when MIDNIGHT_DEPLOYER_WALLET_SEED is unset.
const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

const CUSTOM_SEED = "00000000000000000000000000000000000000000000000000000000000000aa";

// Stagenet's endpoints are deliberately not published in the repo, so the
// environment must supply them before getDeployConfig's node-config read
// resolves (see network.test.ts for that requirement itself).
const STAGENET_ENDPOINTS = {
  MIDNIGHT_NODE_URL: "https://node.example",
  MIDNIGHT_INDEXER_URL: "https://indexer.example/api/v4/graphql",
};

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  expectedSeed: string;
  expectedNetworkId: NetworkId;
}

const CASES: Case[] = [
  {
    name: "empty env → genesis mint seed on undeployed",
    env: {},
    expectedSeed: GENESIS_MINT_WALLET_SEED,
    expectedNetworkId: "undeployed",
  },
  {
    name: "MIDNIGHT_DEPLOYER_WALLET_SEED is used and trimmed",
    env: { MIDNIGHT_DEPLOYER_WALLET_SEED: `  ${CUSTOM_SEED}  ` },
    expectedSeed: CUSTOM_SEED,
    expectedNetworkId: "undeployed",
  },
  {
    name: "whitespace-only MIDNIGHT_DEPLOYER_WALLET_SEED falls back to the genesis mint seed",
    env: { MIDNIGHT_DEPLOYER_WALLET_SEED: "   " },
    expectedSeed: GENESIS_MINT_WALLET_SEED,
    expectedNetworkId: "undeployed",
  },
  {
    name: "MIDNIGHT_NETWORK_ID flows through to the node config",
    env: { MIDNIGHT_NETWORK_ID: "preview", MIDNIGHT_DEPLOYER_WALLET_SEED: CUSTOM_SEED },
    expectedSeed: CUSTOM_SEED,
    expectedNetworkId: "preview",
  },
  {
    name: "a deployed network uses the provided MIDNIGHT_DEPLOYER_WALLET_SEED",
    env: {
      MIDNIGHT_NETWORK_ID: "stagenet",
      MIDNIGHT_DEPLOYER_WALLET_SEED: CUSTOM_SEED,
      ...STAGENET_ENDPOINTS,
    },
    expectedSeed: CUSTOM_SEED,
    expectedNetworkId: "stagenet",
  },
];

describe("getDeployConfig", () => {
  it.each(CASES)("$name", ({ env, expectedSeed, expectedNetworkId }) => {
    const config = getDeployConfig(env);
    expect(config.deployerSeed).toBe(expectedSeed);
    expect(config.midnightNodeConfig.networkId).toBe(expectedNetworkId);
  });
});

// On a deployed network the genesis mint wallet is unfunded, so getDeployConfig
// refuses to fall back to it: a funded MIDNIGHT_DEPLOYER_WALLET_SEED is mandatory there.
interface ThrowCase {
  name: string;
  env: Record<string, string | undefined>;
  expectedMessage: RegExp;
}

const THROW_CASES: ThrowCase[] = [
  {
    name: "deployed network without MIDNIGHT_DEPLOYER_WALLET_SEED demands one",
    env: { MIDNIGHT_NETWORK_ID: "stagenet", ...STAGENET_ENDPOINTS },
    expectedMessage: /MIDNIGHT_DEPLOYER_WALLET_SEED is required on "stagenet"/,
  },
  {
    name: "deployed network with a whitespace MIDNIGHT_DEPLOYER_WALLET_SEED demands one",
    env: { MIDNIGHT_NETWORK_ID: "preprod", MIDNIGHT_DEPLOYER_WALLET_SEED: "   " },
    expectedMessage: /MIDNIGHT_DEPLOYER_WALLET_SEED is required on "preprod"/,
  },
  {
    name: "deployed network rejects the (unfunded here) genesis mint seed",
    env: {
      MIDNIGHT_NETWORK_ID: "stagenet",
      MIDNIGHT_DEPLOYER_WALLET_SEED: GENESIS_MINT_WALLET_SEED,
      ...STAGENET_ENDPOINTS,
    },
    expectedMessage: /genesis mint seed, which holds no funds on "stagenet"/,
  },
  {
    name: "an env-provided MIDNIGHT_FAUCET_URL appears in the funding hint",
    env: {
      MIDNIGHT_NETWORK_ID: "stagenet",
      MIDNIGHT_FAUCET_URL: "https://faucet.example",
      ...STAGENET_ENDPOINTS,
    },
    expectedMessage: /faucet\.example/,
  },
];

describe("getDeployConfig on deployed networks", () => {
  it.each(THROW_CASES)("$name", ({ env, expectedMessage }) => {
    expect(() => getDeployConfig(env)).toThrow(expectedMessage);
  });
});
