// Add the 5 Aave circuits to a deployed base vault via the proven ledger-level maintenance-update
// path: operation-version 'v4' (which accepts the v7 verifier key), bypassing compact-js's 'v3'
// path. Each circuit is one MaintenanceUpdate signed by the retained MAINTENANCE_SIGNING_KEY.
// Mirrors insert-ping-stagenet.ts, generalised to a sequence: it re-syncs the wallet per insert
// (fresh fee coins) and waits for the authority counter to advance by one before the next, so
// every update signs against the current counter.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  deriveAccountKeys,
  getMidnightNodeConfig,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
} from "@midnight-examples/lib";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import * as ledger from "@midnightntwrk/ledger-v9";

const env = process.env;
const req = (k: string): string => {
  const v = env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

// The circuits absent from the base deploy, added here. Each insert is independent, so order is
// free; a stable order keeps the counter log readable.
const AAVE_CIRCUITS = [
  "approveStata",
  "supply",
  "completeSupply",
  "redeem",
  "completeRedeem",
] as const;

const KEYS_DIR = new URL("../contract/src/managed/erc20-vault/keys/", import.meta.url);
const readVerifierKey = (circuitId: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`${circuitId}.verifier`, KEYS_DIR))));

type Pdp = IndexerPublicDataProvider;

async function readContractState(pdp: Pdp, addr: string) {
  const rs = await pdp.queryContractState(addr);
  if (!rs) throw new Error("no contract state");
  return ledger.ContractState.deserialize(rs.serialize());
}

async function main(): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  setNetworkId(nodeConfig.networkId);
  const deployerSeed = req("MIDNIGHT_DEPLOYER_WALLET_SEED");
  const addr = req("VAULT_CONTRACT_ADDRESS");
  const maintHex = req("MAINTENANCE_SIGNING_KEY").replace(/^0x/i, "");
  const accountKeys = deriveAccountKeys(deployerSeed, nodeConfig.networkId);
  const sk = ledger.signingKeyFromBip340(Uint8Array.from(Buffer.from(maintHex, "hex")));

  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });

  for (const circuitId of AAVE_CIRCUITS) {
    const cs = await readContractState(pdp, addr);
    const counter = cs.maintenanceAuthority.counter;
    console.log(
      `\n[${circuitId}] authority counter ${counter.toString()} | committee ${String(
        cs.maintenanceAuthority.committee.length,
      )}`,
    );

    const vk = readVerifierKey(circuitId);
    const vop = new ledger.ContractOperationVersionedVerifierKey("v4", vk);
    const insert = new ledger.VerifierKeyInsert(circuitId, vop);
    let update = new ledger.MaintenanceUpdate(addr, [insert], counter);
    update = update.addSignature(0n, ledger.signData(sk, update.dataToSign));

    const intent = ledger.Intent.new(new Date(Date.now() + 3600_000)).addMaintenanceUpdate(update);
    const tx = ledger.Transaction.fromPartsRandomized(
      nodeConfig.networkId,
      undefined,
      undefined,
      intent,
    );
    const serialized = tx.serialize();

    await withSyncedWalletFacade(accountKeys, nodeConfig, async (facade) => {
      const txId = await submitUnprovenTransaction(facade, accountKeys, serialized);
      console.log(
        `[${circuitId}] maintenance tx submitted ${txId} (vk ${String(vk.length)} bytes, ` +
          `tx ${String(serialized.length)} bytes)`,
      );
    });

    // The authority counter advances by exactly one per applied maintenance update. Wait for it so
    // the next circuit signs against the fresh counter.
    const target = counter + 1n;
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const now = (await readContractState(pdp, addr)).maintenanceAuthority.counter;
      if (now >= target) {
        console.log(`[${circuitId}] confirmed at counter ${now.toString()}`);
        break;
      }
      if (Date.now() > deadline)
        throw new Error(`[${circuitId}] timed out waiting for counter ${target.toString()}`);
    }
  }

  console.log("\nALL AAVE CIRCUITS INSERTED");
  process.exit(0);
}
main().catch((e: unknown) => {
  const err = e as { stack?: string; message?: string };
  console.error("FAILED:", err.stack ?? err.message ?? e);
  process.exit(1);
});
