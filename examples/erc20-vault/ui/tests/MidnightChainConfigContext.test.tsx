import { DEFAULT_ENDPOINTS, NETWORK_IDS, type NetworkId } from "@midnight-examples/chain-config";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MidnightChainConfigProvider, useMidnightChainConfig } from "../src/components/contexts";

// No VITE_MIDNIGHT_* variables are set under vitest, so the app starts on the
// local standalone stack and every endpoint comes from its published defaults.
const STARTING_NETWORK_ID: NetworkId = "undeployed";

describe("MidnightChainConfigProvider", () => {
  it("starts on the local standalone stack with its default endpoints", () => {
    const { result } = renderHook(() => useMidnightChainConfig(), {
      wrapper: MidnightChainConfigProvider,
    });

    expect(result.current.config).toEqual({
      networkId: STARTING_NETWORK_ID,
      ...DEFAULT_ENDPOINTS[STARTING_NETWORK_ID],
    });
  });

  // Switching resets every endpoint to the target network's published
  // defaults. Stagenet's are blank on purpose: this repo does not publish
  // them, so selecting it at runtime yields empty endpoints by design.
  it.each(NETWORK_IDS)(
    "setNetworkId(%s) resets the endpoints to that network's defaults",
    (networkId) => {
      const { result } = renderHook(() => useMidnightChainConfig(), {
        wrapper: MidnightChainConfigProvider,
      });

      act(() => {
        result.current.setNetworkId(networkId);
      });

      expect(result.current.config).toEqual({ networkId, ...DEFAULT_ENDPOINTS[networkId] });
    },
  );

  type MidnightChainConfigSetters = ReturnType<typeof useMidnightChainConfig>;

  /** An endpoint override, and what the config must look like afterwards. */
  interface OverrideCase {
    readonly description: string;
    readonly apply: (value: MidnightChainConfigSetters, url: string) => void;
    readonly url: string;
    readonly expected: Readonly<Record<string, string>>;
  }

  const OVERRIDE_CASES: readonly OverrideCase[] = [
    {
      description: "setIndexerUrl also derives the WebSocket twin",
      apply: (value, url) => {
        value.setIndexerUrl(url);
      },
      url: "https://indexer.example/api/v4/graphql",
      expected: {
        indexerUrl: "https://indexer.example/api/v4/graphql",
        indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
      },
    },
    {
      description: "setNodeUrl replaces only the node RPC",
      apply: (value, url) => {
        value.setNodeUrl(url);
      },
      url: "https://node.example/",
      expected: { nodeUrl: "https://node.example/" },
    },
    {
      description: "setProofServerUrl replaces only the proof server",
      apply: (value, url) => {
        value.setProofServerUrl(url);
      },
      url: "http://127.0.0.1:7300/",
      expected: { proofServerUrl: "http://127.0.0.1:7300/" },
    },
  ];

  it.each(OVERRIDE_CASES)("$description", ({ apply, url, expected }) => {
    const { result } = renderHook(() => useMidnightChainConfig(), {
      wrapper: MidnightChainConfigProvider,
    });

    act(() => {
      apply(result.current, url);
    });

    expect(result.current.config).toEqual({
      networkId: STARTING_NETWORK_ID,
      ...DEFAULT_ENDPOINTS[STARTING_NETWORK_ID],
      ...expected,
    });
  });

  it("rejects an endpoint override that is not an absolute URL", () => {
    const { result } = renderHook(() => useMidnightChainConfig(), {
      wrapper: MidnightChainConfigProvider,
    });

    expect(() => {
      act(() => {
        result.current.setNodeUrl("127.0.0.1:9944");
      });
    }).toThrow();
  });
});

describe("useMidnightChainConfig", () => {
  it("throws when called outside a provider", () => {
    expect(() => renderHook(() => useMidnightChainConfig())).toThrow(
      /must be used within a MidnightChainConfigProvider/,
    );
  });
});
