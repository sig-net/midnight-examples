// EVM read helpers the examples' deploy flows and the test harness share
// (per the repo convention, ethers is the Ethereum library).

import { JsonRpcProvider } from "ethers";

/**
 * Read the chain id the RPC endpoint reports.
 *
 * @param rpcUrl - JSON-RPC endpoint (e.g. `EVM_RPC_URL`).
 * @returns The chain id (e.g. 31337n for the local dev node).
 * @throws {Error} If the endpoint does not answer.
 */
export async function getEvmChainId(rpcUrl: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return (await provider.getNetwork()).chainId;
  } finally {
    provider.destroy();
  }
}

/**
 * The latest block number the EVM node at `rpcUrl` reports.
 *
 * @param rpcUrl - The EVM JSON-RPC endpoint.
 * @returns The latest block number.
 */
export async function getEvmBlockNumber(rpcUrl: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return BigInt(await provider.getBlockNumber());
  } finally {
    provider.destroy();
  }
}
