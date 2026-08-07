import type { EvmChainConfig } from "@midnight-examples/chain-config";
import { type Chain, defineChain } from "viem";

/**
 * The app's {@link EvmChainConfig} as the viem `Chain` its clients are built
 * over.
 *
 * The chain's name and native currency are display metadata that
 * {@link EvmChainConfig} does not carry and nothing here depends on: what
 * matters is the chain id, which is the routing key an example seals into its
 * contract, and the RPC URL behind it.
 *
 * @param config - The EVM chain the app runs against.
 * @returns A viem chain over that config.
 */
export function toViemChain(config: EvmChainConfig): Chain {
  return defineChain({
    id: Number(config.chainId),
    name: `EVM chain ${String(config.chainId)}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorerUrl === undefined
      ? {}
      : { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } }),
  });
}
