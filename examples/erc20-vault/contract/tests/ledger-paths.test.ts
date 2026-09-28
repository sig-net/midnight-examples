// Pins the exported ledger-tree path constants to the compiler's recorded
// field indexes. Any ledger declaration change re-chunks the state tree and
// silently moves every path (see the CAUTION over the ledger block in
// erc20-vault.compact), so this is the tripwire that turns that drift into a
// unit-test failure instead of an MPC that never answers requests.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  VAULT_DEPOSIT_REQUESTS_PATH,
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
    ["signBidirectionalEventMap", VAULT_REQUESTS_PATH, [0, 0]],
    ["depositEventMap", VAULT_DEPOSIT_REQUESTS_PATH, [2, 2]],
    ["swapEventMap", VAULT_SWAP_REQUESTS_PATH, [2, 6]],
    ["supplyEventMap", VAULT_SUPPLY_REQUESTS_PATH, [2, 11]],
    ["redeemEventMap", VAULT_REDEEM_REQUESTS_PATH, [2, 13]],
    // The literal column is deliberate: the notification vectors in
    // erc20-vault.compact are hand-written, so a re-chunk that moves a path
    // must fail here even when the exported constant was updated with it.
  ] as const)("%s", (fieldName, exportedPath, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
    expect(exportedPath).toEqual(compiledPath);
  });
});

describe("the admin-updateable gas parameters sit in chunk 1", () => {
  it.each([
    ["vaultMaxFeePerGas", [1, 2]],
    ["vaultMaxPriorityFeePerGas", [1, 3]],
    ["vaultGasLimits", [1, 4]],
  ] as const)("%s", (fieldName, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
  });
});

describe("the state tree stays THREE chunks deep", () => {
  it("holds at most 45 fields, the three chunks' worth", () => {
    expect(contractInfo.ledger.length).toBeLessThanOrEqual(45);
  });

  it("uses exactly three chunks, at depth 2", () => {
    const chunks = new Set(contractInfo.ledger.map((field) => field.index[0]));
    const depths = new Set(contractInfo.ledger.map((field) => field.index.length));

    expect([...chunks].sort()).toEqual([0, 1, 2]);
    expect([...depths]).toEqual([2]);
  });
});

describe("the chunk-2 block holds the event maps at their pinned offsets", () => {
  it("holds the same 15 fields at the same offsets", () => {
    const chunkTwo = contractInfo.ledger
      .filter((field) => field.index[0] === 2)
      .map((field) => [field.name, [...field.index]] as const);

    expect(chunkTwo).toEqual([
      ["stamps", [2, 0]],
      ["nonceOwners", [2, 1]],
      ["depositEventMap", [2, 2]],
      ["depositSettleViews", [2, 3]],
      ["withdrawSettleViews", [2, 4]],
      ["uniswapRouter", [2, 5]],
      ["swapEventMap", [2, 6]],
      ["swapSettleViews", [2, 7]],
      ["stataUnderlying", [2, 8]],
      ["stataToken", [2, 9]],
      ["allowedTokens", [2, 10]],
      ["supplyEventMap", [2, 11]],
      ["supplySettleViews", [2, 12]],
      ["redeemEventMap", [2, 13]],
      ["redeemSettleViews", [2, 14]],
    ]);
  });

  it("is exactly the last 15 declared fields, so nothing may be appended", () => {
    const names = contractInfo.ledger.map((field) => field.name);
    const chunkTwoNames = contractInfo.ledger
      .filter((field) => field.index[0] === 2)
      .map((field) => field.name);

    expect(chunkTwoNames).toHaveLength(15);
    expect(names.slice(-15)).toEqual(chunkTwoNames);
  });
});
