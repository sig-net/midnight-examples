// Records a deployed erc20-vault's address in the contract package's published
// per-network table (`yarn record-contract-address --network <id> --address
// <hex>`, run by tsx). The deploy workflow calls it on a checkout of dev and
// opens a PR with the one-line diff, so the address reaches npm consumers only
// after a human reviews it. The rewrite is recordContractAddress in
// src/record-contract-address.ts, which throws rather than guess, so this
// shell writes the file only after a successful rewrite and a bad run never
// touches it.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { contractAddressFromHex } from "@sig-net/midnight";

import {
  parseDeployedNetwork,
  recordContractAddress,
  VAULT_ADDRESSES_PATH,
} from "../src/record-contract-address.ts";

const { values } = parseArgs({
  options: { network: { type: "string" }, address: { type: "string" } },
});
if (values.network === undefined || values.address === undefined) {
  throw new Error("usage: --network <id> --address <64-hex>");
}
const network = parseDeployedNetwork(values.network);
const address = contractAddressFromHex(values.address);

const recorded = recordContractAddress(
  readFileSync(VAULT_ADDRESSES_PATH, "utf8"),
  network,
  address,
);
writeFileSync(VAULT_ADDRESSES_PATH, recorded.source);

console.log(`recorded the ${network} erc20-vault contract address in ${VAULT_ADDRESSES_PATH}`);
console.log(`  ${recorded.previousEntry} -> ${recorded.entry}`);
