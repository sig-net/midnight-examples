// Thin tsx entrypoint over src/vault-ledger.ts for hand-driving a live
// stack: print the vault's public ledger state (initialization, sealed EVM
// address, pinned chain, pending signature requests). Needs only the indexer
// — no wallet, no proving keys. Run:
//   yarn workspace @midnight-examples/erc20-vault-integration-tests read-state

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";

import { getMidnightNodeConfig } from "@midnight-examples/lib";
import { buildBaseEnv, requireEnv } from "@midnight-examples/test-harness";

import { printVaultState } from "../src/vault-ledger.ts";

const env = buildBaseEnv();
const nodeConfig = getMidnightNodeConfig(env);
setNetworkId(nodeConfig.networkId);

await printVaultState(
  indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  }),
  requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
);
