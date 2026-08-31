// One-shot deploy + initialise of the vault on a REMOTE network (stagenet). The deploy itself
// runs the contract package's own `deploy` entrypoint as a subprocess, the same way the e2e
// setup does, so the split base-deploy plus maintenance-adds has exactly ONE implementation.
// This script then joins the new address and runs the deployer-gated initialise (vault EVM
// address + router + Aave pair + chain + MPC response key derived from MPC_SECP256K1_PUBKEY and
// the new contract address). Prints the address to set as
// NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS in the frontend.
//
// Env: NETWORK_ID, MIDNIGHT_NODE_URL, MIDNIGHT_NODE_INDEXER_URL, MIDNIGHT_NODE_INDEXER_WS_URL,
//      MIDNIGHT_NODE_PROOF_SERVER_URL, DEPLOYER_SEED (funded), MIDNIGHT_SIGNET_CONTRACT_ADDRESS,
//      MPC_SECP256K1_PUBKEY, EVM_CHAIN_ID, ROUTER (optional).
import { createVaultPrivateState } from "@midnight-examples/erc20-vault-contract";
import {
  deriveAccountKeys,
  getMidnightNodeConfig,
  parseIdentitySecretKey,
  withSyncedWalletFacade,
} from "@midnight-examples/lib";
import { runCommand } from "@midnight-examples/test-harness";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  asciiPadded,
  CAIP2_ID_BYTES,
  deriveEvmAddress,
  deriveMidnightResponseKey,
  formatSecp256k1PublicKey,
  hexToBytes,
  parseSecp256k1PublicKey,
  stripHexPrefix,
} from "@sig-net/midnight";

import {
  buildVaultProviders,
  VAULT_PRIVATE_STATE_ID,
  vaultCompiledContract,
} from "./src/vault-providers.ts";

const UNISWAP_SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
// Aave v3 Sepolia: the underlying USDC the vault lends and its non-rebasing ERC-4626 wrapper.
const AAVE_USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const STATA_USDC = "0x8A88124522dbBF1E56352ba3DE1d9F78C143751e";
const evmAddressBytes = (hex: string): Uint8Array => {
  const digits = stripHexPrefix(hex);
  if (!/^[0-9a-fA-F]{40}$/.test(digits)) {
    throw new Error(`not a 20-byte EVM address in hex: "${hex}"`);
  }
  return hexToBytes(digits);
};

const env = process.env;
const req = (k: string): string => {
  const v = env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
// A set-but-empty variable (a blank `KEY=` line in .env) means unset: only a
// non-empty value overrides the fallback.
const opt = (k: string, fallback: string): string => {
  const v = env[k]?.trim();
  if (!v) return fallback;
  return v;
};

async function main(): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  const { networkId } = nodeConfig;
  setNetworkId(networkId);

  const deployerSeed = req("DEPLOYER_SEED");
  const signetAddr = req("MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const mpcSecpPub = req("MPC_SECP256K1_PUBKEY");
  const evmChainId = BigInt(req("EVM_CHAIN_ID"));
  const router = opt("ROUTER", UNISWAP_SWAP_ROUTER_02);
  const stataUnderlying = opt("STATA_UNDERLYING", AAVE_USDC);
  const stataToken = opt("STATA_TOKEN", STATA_USDC);

  const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", env, deployerSeed);
  const accountKeys = deriveAccountKeys(deployerSeed, networkId);

  console.log(`deploying swap-capable erc20-vault to ${networkId} (${nodeConfig.nodeUrl})`);
  console.log(`signet: ${signetAddr}`);

  // The 17-circuit contract does not fit one block, so the deploy is a split base deploy plus
  // one maintenance update per remaining circuit. That lives in the contract package's deploy
  // entrypoint; run it rather than reimplementing it.
  const deployStdout = await runCommand(
    "yarn",
    ["workspace", "@midnight-examples/erc20-vault-contract", "deploy"],
    env,
    30 * 60_000,
  );
  const contractAddress = /deployed erc20-vault at (\S+)/.exec(deployStdout)?.[1];
  if (contractAddress === undefined) {
    throw new Error("vault deploy printed no `deployed erc20-vault at <address>` line");
  }
  console.log(`deployed erc20-vault at ${contractAddress}`);

  await withSyncedWalletFacade(accountKeys, nodeConfig, async (facade) => {
    // Join the freshly-deployed contract and run the deployer-gated initialise.
    const providers = buildVaultProviders(facade, accountKeys, nodeConfig);
    const vault = await findDeployedContract(providers, {
      contractAddress,
      compiledContract: vaultCompiledContract,
      privateStateId: VAULT_PRIVATE_STATE_ID,
      initialPrivateState: createVaultPrivateState(secretKey),
    } as never);

    const vaultEvmAddress = deriveEvmAddress(mpcSecpPub, contractAddress, "vault");
    const mpcResponseKey = formatSecp256k1PublicKey(
      deriveMidnightResponseKey(mpcSecpPub, contractAddress),
    );
    const caip2Id = `eip155:${String(evmChainId)}`;
    console.log(
      `initialise: vaultEvm=${vaultEvmAddress} router=${router} stataUnderlying=${stataUnderlying} stataToken=${stataToken} chain=${String(evmChainId)} responseKey=${mpcResponseKey}`,
    );

    const initRes = await (
      vault as never as {
        callTx: { initialise: (...a: unknown[]) => Promise<{ public: { txId: string } }> };
      }
    ).callTx.initialise(
      evmAddressBytes(vaultEvmAddress),
      evmAddressBytes(router),
      evmAddressBytes(stataUnderlying),
      evmAddressBytes(stataToken),
      evmChainId,
      asciiPadded(caip2Id, CAIP2_ID_BYTES),
      parseSecp256k1PublicKey(mpcResponseKey),
    );
    console.log(`initialise tx ${initRes.public.txId}`);

    console.log("\n==================== DONE ====================");
    console.log(`NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
    console.log("=============================================");
  });
}

await main();
