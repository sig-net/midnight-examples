// Network identity + endpoint primitives. Pure — no network, no environment.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENDPOINTS,
  EVM_CHAINS,
  evmCaip2ChainId,
  evmChainById,
  FAUCET_URLS,
  indexerWsUrlFromIndexerUrl,
  isLocalStandaloneNetwork,
  LOCAL_EVM_CHAIN,
  LOCAL_PROOF_SERVER,
  NETWORK_IDS,
  type NetworkId,
} from "../src/index.ts";

describe("network ids", () => {
  it("includes stagenet", () => {
    expect(NETWORK_IDS).toContain("stagenet");
  });

  interface StandaloneCase {
    networkId: NetworkId;
    expected: boolean;
  }
  const STANDALONE_CASES: StandaloneCase[] = [
    { networkId: "undeployed", expected: true },
    { networkId: "stagenet", expected: false },
    { networkId: "preview", expected: false },
    { networkId: "preprod", expected: false },
    { networkId: "mainnet", expected: false },
  ];
  it.each(STANDALONE_CASES)(
    "isLocalStandaloneNetwork($networkId) === $expected",
    ({ networkId, expected }) => {
      expect(isLocalStandaloneNetwork(networkId)).toBe(expected);
    },
  );
});

describe("default endpoints", () => {
  it.each(NETWORK_IDS)("%s has an entry whose proof server stays local", (networkId) => {
    expect(DEFAULT_ENDPOINTS[networkId].proofServerUrl).toBe(LOCAL_PROOF_SERVER);
  });

  // Stagenet's endpoints are deliberately not published in this repo: the
  // defaults are blank and a consumer's environment must supply them.
  it("publishes no stagenet endpoints", () => {
    expect(DEFAULT_ENDPOINTS.stagenet).toEqual({
      indexerUrl: "",
      indexerWsUrl: "",
      nodeUrl: "",
      proofServerUrl: LOCAL_PROOF_SERVER,
    });
  });

  it("publishes no stagenet faucet URL", () => {
    expect(FAUCET_URLS.stagenet).toBeUndefined();
  });
});

describe("indexerWsUrlFromIndexerUrl", () => {
  interface WsCase {
    indexerUrl: string;
    expected: string;
  }
  const WS_CASES: WsCase[] = [
    {
      indexerUrl: "https://indexer.example/api/v4/graphql",
      expected: "wss://indexer.example/api/v4/graphql/ws",
    },
    {
      indexerUrl: "http://127.0.0.1:8088/api/v3/graphql",
      expected: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    },
    // A trailing slash must not produce a doubled separator.
    {
      indexerUrl: "https://indexer.example/graphql/",
      expected: "wss://indexer.example/graphql/ws",
    },
  ];
  it.each(WS_CASES)("$indexerUrl -> $expected", ({ indexerUrl, expected }) => {
    expect(indexerWsUrlFromIndexerUrl(indexerUrl)).toBe(expected);
  });

  it("rejects a non-absolute URL", () => {
    expect(() => indexerWsUrlFromIndexerUrl("/api/v3/graphql")).toThrow();
  });
});

describe("EVM chain config", () => {
  // The compose stack's `evm` service is anvil on its default chain id. These
  // are the values the e2e suite and the UI both start from, so a change here
  // silently repoints both.
  it("defaults to the local anvil dev chain, with no explorer", () => {
    expect(LOCAL_EVM_CHAIN).toEqual({ chainId: 31337n, rpcUrl: "http://127.0.0.1:8545" });
  });

  /** A chain id, and the CAIP-2 string an example seals for it. */
  interface Caip2Case {
    chainId: bigint;
    expected: string;
  }
  const CAIP2_CASES: Caip2Case[] = [
    { chainId: 31337n, expected: "eip155:31337" },
    { chainId: 1n, expected: "eip155:1" },
    { chainId: 11155111n, expected: "eip155:11155111" },
  ];
  it.each(CAIP2_CASES)("evmCaip2ChainId($chainId) === $expected", ({ chainId, expected }) => {
    expect(evmCaip2ChainId(chainId)).toBe(expected);
  });

  // The id is sealed into the contract as ASCII and must never carry the
  // bigint literal's trailing "n".
  it("emits no bigint suffix", () => {
    expect(evmCaip2ChainId(31337n)).not.toContain("n");
  });
});

describe("named EVM chains", () => {
  // The examples develop against the local chain, so a picker fed by this
  // table must offer it first.
  it("leads with the local anvil chain", () => {
    expect(EVM_CHAINS[0]).toEqual({ name: "Local anvil", ...LOCAL_EVM_CHAIN });
  });

  it("has a unique chain id per entry", () => {
    const ids = EVM_CHAINS.map((chain) => chain.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** A chain id, and the named chain expected back (undefined for unknown). */
  interface ChainByIdCase {
    chainId: bigint;
    expectedName: string | undefined;
  }
  const CHAIN_BY_ID_CASES: ChainByIdCase[] = [
    { chainId: 31337n, expectedName: "Local anvil" },
    { chainId: 1n, expectedName: "Ethereum" },
    { chainId: 11155111n, expectedName: "Sepolia" },
    { chainId: 424242n, expectedName: undefined },
  ];
  it.each(CHAIN_BY_ID_CASES)(
    "evmChainById($chainId) -> $expectedName",
    ({ chainId, expectedName }) => {
      expect(evmChainById(chainId)?.name).toBe(expectedName);
    },
  );
});
