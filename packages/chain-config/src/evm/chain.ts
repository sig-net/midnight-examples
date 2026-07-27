// EVM chain connection config. Deliberately far smaller than the Midnight
// side: an EVM chain is reached through ONE JSON-RPC endpoint, so there is no
// endpoint set to keep consistent and no named-network table to select from.

/**
 * Everything needed to reach one EVM chain.
 *
 * The chain id is not decoration: an example seals `eip155:<chainId>` into its
 * contract at initialize, and that is the routing key the MPC signs against. A
 * config whose chain id disagrees with the chain its RPC actually serves
 * produces requests the vault will not honour, so it must be verified against
 * the live chain before it is trusted. Verifying is the consumer's job, since
 * it needs a network round trip: this type only carries what was configured.
 */
export interface EvmChainConfig {
  /** Chain id, as reported by `eth_chainId`. */
  readonly chainId: bigint;
  /** JSON-RPC endpoint of the chain. */
  readonly rpcUrl: string;
  /** Base URL of a block explorer, when the chain has one. */
  readonly explorerUrl?: string;
}

/**
 * The local dev chain: the `evm` docker compose service, which runs anvil on
 * its default chain id with the universal pre-funded dev accounts. Its state
 * is in-memory, so a restart wipes it. It publishes no block explorer.
 */
export const LOCAL_EVM_CHAIN: EvmChainConfig = {
  chainId: 31337n,
  rpcUrl: "http://127.0.0.1:8545",
};

/**
 * An EVM chain's CAIP-2 identifier
 * (https://chainagnostic.org/CAIPs/caip-2), the form an example seals into its
 * contract and the MPC routes on. Deriving it in one place keeps every caller
 * agreeing on the exact string, since a mismatch is only ever visible as an
 * unroutable request.
 *
 * This is EVM-specific despite CAIP-2 being a cross-chain standard: the
 * `eip155` namespace is what makes it so. There is no general
 * `caip2(namespace, reference)` counterpart here because there would be
 * nothing else to call it — Midnight's CAIP-2 id is not derived from anything
 * this package knows. It is the fixed protocol constant
 * `MIDNIGHT_TESTNET_CHAIN_ID` in `@sig-net/midnight`, which the MPC's key
 * derivation hashes verbatim, so it is read from the SDK and never rebuilt.
 *
 * @param chainId - The EVM chain id.
 * @returns The CAIP-2 id, as `eip155:<chainId>`.
 */
export function evmCaip2ChainId(chainId: bigint): string {
  return `eip155:${chainId}`;
}
