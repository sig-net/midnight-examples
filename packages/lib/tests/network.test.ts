// Reading a node config out of the environment. Pure — no network, no crypto.
// The primitives these resolve against (network ids, endpoint defaults, the WS
// derivation) are tested in @midnight-examples/chain-config.

import { describe, expect, it } from "vitest";

import { getFaucetUrl, getMidnightNodeConfig } from "../src/index.ts";

// Stagenet's endpoints are deliberately not published in this repo: the
// defaults are blank and the environment must supply them.
describe("getMidnightNodeConfig for stagenet", () => {
  it("REQUIRES the endpoint env vars, failing with the exact names to set", () => {
    expect(() => getMidnightNodeConfig({ MIDNIGHT_NETWORK_ID: "stagenet" })).toThrow(
      /MIDNIGHT_NODE_URL, MIDNIGHT_INDEXER_URL, MIDNIGHT_INDEXER_WS_URL/,
    );
  });

  it("resolves env-provided endpoints (WS twin derived from the indexer URL)", () => {
    const config = getMidnightNodeConfig({
      MIDNIGHT_NETWORK_ID: "stagenet",
      MIDNIGHT_NODE_URL: "https://node.example",
      MIDNIGHT_INDEXER_URL: "https://indexer.example/api/v4/graphql",
    });
    expect(config).toEqual({
      networkId: "stagenet",
      indexerUrl: "https://indexer.example/api/v4/graphql",
      indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
      nodeUrl: "https://node.example",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("rejects an unknown MIDNIGHT_NETWORK_ID", () => {
    expect(() => getMidnightNodeConfig({ MIDNIGHT_NETWORK_ID: "nosuchnet" })).toThrow(/Invalid MIDNIGHT_NETWORK_ID/);
  });

  it("takes MIDNIGHT_FAUCET_URL as the faucet hint, publishing none itself", () => {
    expect(getFaucetUrl({}, "stagenet")).toBeUndefined();
    expect(getFaucetUrl({ MIDNIGHT_FAUCET_URL: "https://faucet.example" }, "stagenet")).toBe(
      "https://faucet.example",
    );
  });
});
