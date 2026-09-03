// Records a deployed erc20-vault's address in this package's published
// per-network table (`yarn record-contract-address --network <id> --address
// <hex>`, run by tsx). The deploy workflow calls it on a checkout of main and
// opens a PR with the one-line diff, so the address reaches npm consumers only
// after a human reviews it.
//
// The rewrite is a single exact-match replace inside the
// `vaultContractAddresses` literal of src/vault-addresses.ts. Anything else
// exits non-zero without touching the file (a pattern that matches zero or
// several times, a network the table has no entry for, an address that is not
// 32 bytes of hex), so a silent no-op can never masquerade as a recorded
// deploy.

import { readFileSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { type DeployedNetwork, MidnightNetwork } from "@sig-net/midnight";

const ADDRESSES_PATH = fileURLToPath(new URL("src/vault-addresses.ts", import.meta.url));

/** The table in vault-addresses.ts this script edits. */
const TABLE_NAME = "vaultContractAddresses";

// Every network the table has an entry for, keyed by its id and valued by the
// enum member name that id is written as inside the table
// (`[MidnightNetwork.Stagenet]: "..."`). Derived from the enum minus the local
// standalone stack, which deploys its own vault per e2e run, so the accepted
// networks are exactly the table's DeployedNetwork keys.
const MEMBER_NAME_BY_NETWORK = new Map<string, string>(
  Object.entries(MidnightNetwork)
    .filter((entry): entry is [string, DeployedNetwork] => entry[1] !== MidnightNetwork.Undeployed)
    .map(([memberName, networkId]) => [networkId, memberName]),
);

/**
 * Read one `--flag value` pair out of `argv`.
 *
 * @param flag - The flag to read, including its leading dashes.
 * @returns The value that follows the flag, trimmed.
 * @throws {Error} If the flag is absent or carries no value.
 */
function requireArg(flag: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} is required: usage --network <id> --address <64-hex>`);
  }
  return value.trim();
}

/**
 * Resolve the enum member name a network id is written as in the table, which
 * doubles as the check that the table has an entry for that network at all.
 *
 * @param networkId - The `--network` value to resolve.
 * @returns The `MidnightNetwork` member name, e.g. `Stagenet`.
 * @throws {Error} If the id names no deployed network.
 */
function parseNetwork(networkId: string): string {
  const memberName = MEMBER_NAME_BY_NETWORK.get(networkId);
  if (memberName === undefined) {
    const known = [...MEMBER_NAME_BY_NETWORK.keys()].join(", ");
    throw new Error(`unknown network "${networkId}": expected one of ${known}`);
  }
  return memberName;
}

/**
 * Check an address is a Midnight contract address (32 bytes of hex) and strip
 * an optional `0x`, the prefix-free form the table stores.
 *
 * @param address - The `--address` value to check.
 * @returns The address as 64 hex characters.
 * @throws {Error} If the address is not 32 bytes of hex.
 */
function parseAddress(address: string): string {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`not a 32-byte contract address in hex: "${address}"`);
  }
  return hex;
}

const network = requireArg("--network");
const memberName = parseNetwork(network);
const address = parseAddress(requireArg("--address"));

const source = readFileSync(ADDRESSES_PATH, "utf8");

const tableStart = source.indexOf(`const ${TABLE_NAME}`);
if (tableStart === -1) {
  throw new Error(`no "${TABLE_NAME}" table in ${ADDRESSES_PATH}`);
}
const tableEnd = source.indexOf("\n};", tableStart);
if (tableEnd === -1) {
  throw new Error(`the "${TABLE_NAME}" table in ${ADDRESSES_PATH} is not closed by "\\n};"`);
}
const table = source.slice(tableStart, tableEnd);

const entryPattern = new RegExp(`(\\[MidnightNetwork\\.${memberName}\\]: )"[0-9a-fA-F]*"`, "g");
const hits = table.match(entryPattern) ?? [];
const previousEntry = hits.at(0);
if (hits.length !== 1 || previousEntry === undefined) {
  throw new Error(
    `expected exactly one ${network} entry in ${TABLE_NAME}, found ${String(hits.length)}`,
  );
}

writeFileSync(
  ADDRESSES_PATH,
  source.slice(0, tableStart) +
    table.replace(entryPattern, `$1"${address}"`) +
    source.slice(tableEnd),
);

// Read the file back to confirm the write landed: this script's whole job is
// that the PR it feeds carries the address the deploy actually produced.
const expectedEntry = `[MidnightNetwork.${memberName}]: "${address}"`;
if (!readFileSync(ADDRESSES_PATH, "utf8").includes(expectedEntry)) {
  throw new Error(`failed to record ${expectedEntry} in ${ADDRESSES_PATH}`);
}

console.log(`recorded the ${network} erc20-vault contract address in ${ADDRESSES_PATH}`);
console.log(`  ${previousEntry} -> ${expectedEntry}`);
