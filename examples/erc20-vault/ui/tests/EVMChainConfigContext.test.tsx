import { LOCAL_EVM_CHAIN } from "@midnight-examples/chain-config";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EVMChainConfigProvider, useEVMChainConfig } from "../src/components/contexts";

describe("EVMChainConfigProvider", () => {
  // No VITE_EVM_* variables are set under vitest, so the app expects the local
  // anvil dev chain the compose stack runs.
  it("starts on the local dev chain, with its CAIP-2 id derived", () => {
    const { result } = renderHook(() => useEVMChainConfig(), {
      wrapper: EVMChainConfigProvider,
    });

    expect(result.current.config).toEqual(LOCAL_EVM_CHAIN);
    expect(result.current.caip2Id).toBe("eip155:31337");
  });

  type EVMChainConfigSetters = ReturnType<typeof useEVMChainConfig>;

  /** A config change, and what the config must look like afterwards. */
  interface OverrideCase {
    readonly description: string;
    readonly apply: (value: EVMChainConfigSetters) => void;
    readonly expected: Partial<typeof LOCAL_EVM_CHAIN>;
  }

  const OVERRIDE_CASES: readonly OverrideCase[] = [
    {
      description: "setRpcUrl replaces only the endpoint",
      apply: (value) => {
        value.setRpcUrl("https://rpc.example/");
      },
      expected: { rpcUrl: "https://rpc.example/" },
    },
    {
      description: "setChainId replaces only the expected chain",
      apply: (value) => {
        value.setChainId(11155111n);
      },
      expected: { chainId: 11155111n },
    },
    {
      description: "setExplorerUrl replaces only the explorer",
      apply: (value) => {
        value.setExplorerUrl("https://sepolia.etherscan.io/");
      },
      expected: { explorerUrl: "https://sepolia.etherscan.io/" },
    },
  ];

  it.each(OVERRIDE_CASES)("$description", ({ apply, expected }) => {
    const { result } = renderHook(() => useEVMChainConfig(), {
      wrapper: EVMChainConfigProvider,
    });

    act(() => {
      apply(result.current);
    });

    expect(result.current.config).toEqual({ ...LOCAL_EVM_CHAIN, ...expected });
  });

  // The CAIP-2 id is the routing key an example seals into its contract, so it
  // must track the chain id rather than being captured once.
  it("re-derives the CAIP-2 id when the chain changes", () => {
    const { result } = renderHook(() => useEVMChainConfig(), {
      wrapper: EVMChainConfigProvider,
    });

    act(() => {
      result.current.setChainId(11155111n);
    });

    expect(result.current.caip2Id).toBe("eip155:11155111");
  });

  it("rejects an RPC override that is not an absolute URL", () => {
    const { result } = renderHook(() => useEVMChainConfig(), {
      wrapper: EVMChainConfigProvider,
    });

    expect(() => {
      act(() => {
        result.current.setRpcUrl("127.0.0.1:8545");
      });
    }).toThrow();
  });
});

describe("useEVMChainConfig", () => {
  it("throws when called outside a provider", () => {
    expect(() => renderHook(() => useEVMChainConfig())).toThrow(
      /must be used within an EVMChainConfigProvider/,
    );
  });
});
