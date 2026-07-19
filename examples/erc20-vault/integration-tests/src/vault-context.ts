// The connected client context every flow takes: resolved configuration +
// the vault providers + the JOINED vault contract handle. Built once per
// flow file (inside a synced wallet session — see
// {@link file://./vault-session.ts createVaultSession}) and handed to the
// flow functions. The pieces come from where they belong: generic wallet
// construction from the harness session, the vault-specific providers /
// witnesses / compiled-contract binding from this example's own modules.

import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
// midnight-js reads a process-global network id (unlike compact-js, which
// takes it explicitly). createVaultContext sets it once per construction.
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";

import { getMidnightNodeConfig, type MidnightNodeConfig } from "@midnight-examples/lib";
import { requireEnv, type SessionWallet } from "@midnight-examples/test-harness";
import { SignetRequestResponseReader } from "@sig-net/midnight";
import {
  createVaultPrivateState,
  VAULT_REQUESTS_INDEX_FIELD,
  type Contract as VaultContract,
  type VaultPrivateState,
} from "@midnight-examples/erc20-vault-contract";

import { resolveUserIdentity, type UserIdentity } from "./vault-identity.ts";
import {
  buildVaultProviders,
  vaultCompiledContract,
  VAULT_PRIVATE_STATE_ID,
  type VaultProviders,
} from "./vault-providers.ts";

/**
 * The joined vault contract handle — midnight-js's found-contract shape typed
 * to the vault's generated contract, so `callTx.initialize(...)` /
 * `callTx.deposit(...)` carry the real circuit signatures.
 */
export type DeployedVaultContract = FoundContract<VaultContract<VaultPrivateState>>;

/**
 * Everything a flow needs: the resolved configuration (all fields REQUIRED —
 * the setup pipeline populates every one before a flow runs), the vault's
 * midnight-js providers, and the joined vault contract. Flows receive this
 * instead of raw env; they never construct providers, wallets, or contract
 * handles themselves.
 */
export interface VaultContext {
  /** Endpoints + network id of the Midnight network in use. */
  readonly nodeConfig: MidnightNodeConfig;
  /** Address of the deployed ERC20 vault contract on Midnight. */
  readonly vaultContractAddress: string;
  /** Address of the deployed central signet contract on Midnight. */
  readonly signetContractAddress: string;
  /** JSON-RPC endpoint of the EVM chain the vault operates on. */
  readonly evmRpcUrl: string;
  /** Chain id of that EVM chain. */
  readonly evmChainId: bigint;
  /** CAIP-2 id derived from `evmChainId` (`eip155:<id>`) — the MPC routing key. */
  readonly caip2Id: string;
  /** Address of the ERC20 token the vault holds (20-byte 0x hex). */
  readonly erc20Address: string;
  /** The vault's derived EVM account (path "vault") — the withdraw tx sender. */
  readonly evmVaultAddress: string;
  /** The user's derived EVM account (path = identity commitment hex) — the sweep tx sender. */
  readonly evmUserAddress: string;
  /** The caller identity every vault interaction is bound to. */
  readonly identity: UserIdentity;
  /** The vault's provider set (public data / proof / zk-config / private state / wallet). */
  readonly providers: VaultProviders;
  /** The vault at `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, joined with witnesses + the identity as private state. */
  readonly vault: DeployedVaultContract;
}

/**
 * Build the {@link VaultContext}: resolve the configuration from the
 * setup-populated env accumulator, set the midnight-js network id, build the
 * vault's providers around the wallet, and join the deployed vault contract
 * with the user identity as private state.
 *
 * @param env - The setup-populated env accumulator.
 * @param wallet - The started wallet (from the harness session's `wallet()`).
 * @returns The context to hand to the flow functions.
 * @throws If a required env value is missing/malformed or no contract answers
 *   at `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 */
export async function createVaultContext(env: NodeJS.ProcessEnv, wallet: SessionWallet): Promise<VaultContext> {
  const nodeConfig = getMidnightNodeConfig(env);
  setNetworkId(nodeConfig.networkId);

  const evmChainIdRaw = requireEnv(env, "EVM_CHAIN_ID");
  if (!/^\d+$/.test(evmChainIdRaw)) {
    throw new Error(`EVM_CHAIN_ID must be a positive integer; got "${evmChainIdRaw}".`);
  }
  const evmChainId = BigInt(evmChainIdRaw);

  const erc20Address = requireEnv(env, "ERC20_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(erc20Address)) {
    throw new Error(`ERC20_ADDRESS must be a 20-byte 0x hex address; got "${erc20Address}".`);
  }

  const vaultContractAddress = requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const identity = resolveUserIdentity(env);
  const providers = buildVaultProviders(wallet.facade, wallet.keys, nodeConfig);

  const vault = await findDeployedContract(providers, {
    contractAddress: vaultContractAddress,
    compiledContract: vaultCompiledContract,
    privateStateId: VAULT_PRIVATE_STATE_ID,
    initialPrivateState: createVaultPrivateState(identity.secretKey),
  });

  return {
    nodeConfig,
    vaultContractAddress,
    signetContractAddress: requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
    evmRpcUrl: requireEnv(env, "EVM_RPC_URL"),
    evmChainId,
    caip2Id: `eip155:${evmChainId}`,
    erc20Address,
    evmVaultAddress: requireEnv(env, "EVM_VAULT_ADDRESS"),
    evmUserAddress: requireEnv(env, "EVM_USER_ADDRESS"),
    identity,
    providers,
    vault,
  };
}

/**
 * A request/response reader over the context's vault (requester) / signet
 * contract pair, reading through the context's indexer-backed public data
 * provider — the same read path the response server uses. Built fresh per
 * flow invocation (the reader caches fetched request records internally).
 *
 * @param context - The flow's context.
 * @returns The reader.
 */
export function createResponseReader(context: VaultContext): SignetRequestResponseReader {
  return new SignetRequestResponseReader({
    requesterContractAddress: context.vaultContractAddress,
    // The vault declares its request index as ledger field 0: the
    // requestsIndexField its notifications pass (erc20-vault.compact).
    requesterRequestsIndexField: VAULT_REQUESTS_INDEX_FIELD,
    signetContractAddress: context.signetContractAddress,
    publicDataProvider: context.providers.publicDataProvider,
  });
}
