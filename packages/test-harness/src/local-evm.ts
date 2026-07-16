// Local-EVM (hardhat/anvil dev chain) setup plumbing: generic contract
// deployment from a compiled artifact and derived-account funding. Setup-only
// — the read helpers the flow tests share live in ./evm.ts. Everything here
// signs with the universally-known dev funder account, which only exists
// pre-funded on a throwaway local chain.

import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther, parseUnits } from "ethers";
import type { InterfaceAbi } from "ethers";

/** EVM chain ids the setup pipeline keys behavior on. */
export enum WellKnownEvmChainId {
  /**
   * Local dev chain (the hardhat/anvil convention) — setup auto-deploys the
   * example's ERC20 when absent and auto-funds the derived accounts.
   */
  LocalDev = 31337,
}

/**
 * Whether `chainId` is the local dev chain ({@link WellKnownEvmChainId.LocalDev}),
 * i.e. whether setup may deploy the test ERC20 and fund accounts from the dev
 * funder account.
 *
 * @param chainId - The chain id reported by the RPC endpoint.
 * @returns `true` for the local dev chain, `false` for any real network.
 */
export function isLocalEvmChain(chainId: bigint): boolean {
  return chainId === BigInt(WellKnownEvmChainId.LocalDev);
}

// Dev account #0 of the universal hardhat/anvil test mnemonic ("test test …
// junk"): pre-funded with 10 000 ETH on every fresh local node, never funded
// on any real network. Deployer of test tokens and source of all top-ups.
const LOCAL_FUNDER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** ETH top-up target per derived account on the local chain, in wei. */
export const LOCAL_ETH_TARGET = parseEther("10");

/** Test-token top-up target per derived account, in 6-decimal token units (1000 USDC). */
export const LOCAL_TOKEN_TARGET = parseUnits("1000", 6);

/**
 * The compiled-contract fields {@link deployEvmContract} needs from a
 * Solidity compiler artifact (hardhat's hh3-artifact-1 shape carries both).
 * Reading the artifact from disk is the example's job — its compiler, its
 * output path.
 */
export interface EvmContractArtifact {
  /** The contract's ABI. */
  abi: InterfaceAbi;
  /** The deployment bytecode as 0x-hex. */
  bytecode: string;
}

/**
 * Deploy a compiled EVM contract to the local dev chain from the dev funder
 * account.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain (`EVM_RPC_URL`).
 * @param artifact - The compiled contract to deploy.
 * @returns The deployed contract's address.
 * @throws If the deployment fails.
 */
export async function deployEvmContract(rpcUrl: string, artifact: EvmContractArtifact): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const funder = new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, funder);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    return await contract.getAddress();
  } finally {
    provider.destroy();
  }
}

const MINTABLE_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

/**
 * Idempotent top-up of one derived account on the local dev chain: bring it to
 * at least {@link LOCAL_ETH_TARGET} wei (sent from the dev funder) and
 * {@link LOCAL_TOKEN_TARGET} token units (via the token's open `mint`). Each
 * asset no-ops when the balance already meets its target, so reruns skip
 * naturally without a separate skip signal.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain (`EVM_RPC_URL`).
 * @param erc20Address - The test token (must expose an open `mint`).
 * @param address - The account to top up.
 * @returns The account's ETH and token balances after the top-up.
 */
export async function topUpLocalAccount(
  rpcUrl: string,
  erc20Address: string,
  address: string,
): Promise<{ ethBalance: bigint; tokenBalance: bigint }> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    // NonceManager: the provider coalesces identical RPC calls for ~250ms,
    // and with instant automine a second tx's nonce lookup can hit that
    // cache and reuse the first tx's nonce — track the nonce locally instead.
    const funder = new NonceManager(new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider));
    const ethBalance = await provider.getBalance(address);
    if (ethBalance < LOCAL_ETH_TARGET) {
      const sendTx = await funder.sendTransaction({ to: address, value: LOCAL_ETH_TARGET - ethBalance });
      await sendTx.wait();
    }
    const token = new Contract(erc20Address, MINTABLE_ERC20_ABI, funder);
    const tokenBalance = (await token.balanceOf(address)) as bigint;
    if (tokenBalance < LOCAL_TOKEN_TARGET) {
      const mintTx = await token.mint(address, LOCAL_TOKEN_TARGET - tokenBalance);
      await mintTx.wait();
    }
    // Computed, not re-read: an immediate re-read through this provider can
    // return the pre-top-up value from its short-lived RPC cache. We sent
    // exactly the shortfall, so below-target balances land exactly on target.
    return {
      ethBalance: ethBalance < LOCAL_ETH_TARGET ? LOCAL_ETH_TARGET : ethBalance,
      tokenBalance: tokenBalance < LOCAL_TOKEN_TARGET ? LOCAL_TOKEN_TARGET : tokenBalance,
    };
  } finally {
    provider.destroy();
  }
}
