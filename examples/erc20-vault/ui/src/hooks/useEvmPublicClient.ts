import { useMemo } from "react";
import { createPublicClient, http, type Chain, type HttpTransport, type PublicClient } from "viem";

import { useEVMChainConfig } from "../components/contexts";
import { toViemChain } from "../lib/evm/chain.ts";

/** The viem client the EVM read hooks share, its chain always in hand. */
export type EvmPublicClient = PublicClient<HttpTransport, Chain>;

/**
 * The app's EVM public client, built over the configured chain's RPC URL and
 * rebuilt exactly when the chain config changes.
 *
 * @returns The client, never undefined: the chain config always resolves (it
 *   falls back to the local defaults), so there is always a chain to read.
 */
export function useEvmPublicClient(): EvmPublicClient {
  const { config } = useEVMChainConfig();
  return useMemo(
    () => createPublicClient({ chain: toViemChain(config), transport: http(config.rpcUrl) }),
    [config],
  );
}
