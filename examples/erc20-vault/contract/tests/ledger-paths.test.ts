// Pins the exported ledger-tree path constants to the compiler's recorded
// field indexes. Any ledger declaration change re-chunks the state tree and
// silently moves every path (see the CAUTION on signBidirectionalEventMap in
// erc20-vault.compact), so this is the tripwire that turns that drift into a
// unit-test failure instead of an MPC that never answers requests.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  VAULT_NONCE_PATH,
  VAULT_REDEEM_REQUESTS_PATH,
  VAULT_REQUESTS_PATH,
  VAULT_SUPPLY_REQUESTS_PATH,
  VAULT_SWAP_REQUESTS_PATH,
} from "../src/index.ts";

interface LedgerFieldInfo {
  readonly name: string;
  readonly index: readonly number[];
}

const contractInfo = JSON.parse(
  readFileSync(
    new URL("../src/managed/erc20-vault/compiler/contract-info.json", import.meta.url),
    "utf8",
  ),
) as { readonly ledger: readonly LedgerFieldInfo[] };

const compiledFieldIndex = (name: string): readonly number[] => {
  const field = contractInfo.ledger.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(`contract-info.json records no ledger field named "${name}"`);
  }
  return field.index;
};

describe("exported ledger paths match the compiled contract-info.json", () => {
  it.each([
    ["signBidirectionalEventMap", VAULT_REQUESTS_PATH],
    ["signetRequestNonce", VAULT_NONCE_PATH],
    ["swapEventMap", VAULT_SWAP_REQUESTS_PATH],
    ["supplyEventMap", VAULT_SUPPLY_REQUESTS_PATH],
    ["redeemEventMap", VAULT_REDEEM_REQUESTS_PATH],
  ] as const)("%s", (fieldName, exportedPath) => {
    expect(exportedPath).toEqual(compiledFieldIndex(fieldName));
  });
});
