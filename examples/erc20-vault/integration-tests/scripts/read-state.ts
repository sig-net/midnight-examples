// Thin tsx entrypoint over the contract package's ledger reads for hand-driving
// a live stack: print the vault's public ledger state (initialisation, sealed
// EVM address, pinned chain, pending signature requests). Needs only the
// indexer: no wallet, no proving keys. Run:
//   yarn workspace @sig-net/midnight-examples-erc20-vault-integration-tests read-state

import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import { printVaultState } from "@sig-net/midnight-examples-erc20-vault-contract";
import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import { requireEnv } from "@sig-net/midnight-examples-test-harness";

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
