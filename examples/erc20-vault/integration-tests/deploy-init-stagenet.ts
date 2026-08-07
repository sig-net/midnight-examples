// One-shot deploy + initialize of the swap-capable vault to a REMOTE network (stagenet),
// reusing the vault's midnight-js providers. Deploys the vault referencing the given signet
// contract, then runs the deployer-gated initialize (vault EVM address + router + chain +
// MPC response key derived from MPC_SECP256K1_PUBKEY + the new contract address). Prints the
// address to set as NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS in the frontend.
//
// Env: NETWORK_ID, MIDNIGHT_NODE_URL, MIDNIGHT_NODE_INDEXER_URL, MIDNIGHT_NODE_INDEXER_WS_URL,
//      MIDNIGHT_NODE_PROOF_SERVER_URL, DEPLOYER_SEED (funded), MIDNIGHT_SIGNET_CONTRACT_ADDRESS,
//      MPC_SECP256K1_PUBKEY, EVM_CHAIN_ID, ROUTER (optional).
import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getMidnightNodeConfig,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
} from "@midnight-examples/lib";
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
import { pureCircuits, createVaultPrivateState } from "@midnight-examples/erc20-vault-contract";

import {
  buildVaultProviders,
  vaultCompiledContract,
  VAULT_PRIVATE_STATE_ID,
} from "./src/vault-providers.ts";

const UNISWAP_SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
const evmAddressBytes = (hex: string) => hexToBytes(stripHexPrefix(hex));
const contractRef = (addr: string) => ({ bytes: hexToBytes(stripHexPrefix(addr)) });

const env = process.env;
const req = (k: string): string => {
  const v = env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
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
  const router = env.ROUTER?.trim() || UNISWAP_SWAP_ROUTER_02;

  const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", env, deployerSeed);
  const deployerCommitment = pureCircuits.userCommitment(secretKey);
  const accountKeys = deriveAccountKeys(deployerSeed, networkId);

  console.log(`deploying swap-capable erc20-vault to ${networkId} (${nodeConfig.nodeUrl})`);
  console.log(`signet: ${signetAddr}`);

  await withSyncedWalletFacade(accountKeys, nodeConfig, async (facade, state) => {
    assertDeployerFunded(state);

    const deployTransaction = await buildDeployTransaction(
      vaultCompiledContract,
      networkId,
      accountKeys.shieldedSecretKeys.coinPublicKey,
      createVaultPrivateState(secretKey),
      deployerCommitment,
      contractRef(signetAddr),
    );
    const contractAddress = deployTransaction.contractAddress;
    console.log(`contract address (pre-submit): ${contractAddress}`);

    const deployTxId = await submitUnprovenTransaction(
      facade,
      accountKeys,
      deployTransaction.serializedTransaction,
    );
    console.log(`submitted deploy tx ${deployTxId}`);

    // Join the freshly-deployed contract and run the deployer-gated initialize.
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
    const caip2Id = `eip155:${evmChainId}`;
    console.log(
      `initialize: vaultEvm=${vaultEvmAddress} router=${router} chain=${evmChainId} responseKey=${mpcResponseKey}`,
    );

    const initRes = await (
      vault as never as {
        callTx: { initialize: (...a: unknown[]) => Promise<{ public: { txId: string } }> };
      }
    ).callTx.initialize(
      evmAddressBytes(vaultEvmAddress),
      evmAddressBytes(router),
      evmChainId,
      asciiPadded(caip2Id, CAIP2_ID_BYTES),
      parseSecp256k1PublicKey(mpcResponseKey),
    );
    console.log(`initialize tx ${initRes.public.txId}`);

    console.log("\n==================== DONE ====================");
    console.log(`NEXT_PUBLIC_MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
    console.log("=============================================");
  });
}

await main();
