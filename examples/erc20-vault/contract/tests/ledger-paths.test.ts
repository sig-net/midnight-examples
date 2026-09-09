// Pins the exported ledger-tree path constants to the compiler's recorded
// field indexes. Any ledger declaration change re-chunks the state tree and
// silently moves every path (see the CAUTION over the ledger block in
// erc20-vault.compact), so this is the tripwire that turns that drift into a
// unit-test failure instead of an MPC that never answers requests.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  VAULT_DEPOSIT_REQUESTS_PATH,
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
    ["signBidirectionalEventMap", VAULT_REQUESTS_PATH, [0, 0]],
    ["signetRequestNonce", VAULT_NONCE_PATH, [0, 3]],
    ["depositEventMap", VAULT_DEPOSIT_REQUESTS_PATH, [1, 3]],
    ["swapEventMap", VAULT_SWAP_REQUESTS_PATH, [1, 7]],
    ["supplyEventMap", VAULT_SUPPLY_REQUESTS_PATH, [1, 11]],
    ["redeemEventMap", VAULT_REDEEM_REQUESTS_PATH, [1, 13]],
    // The literal column is deliberate: the notification vectors in
    // erc20-vault.compact are hand-written, so a re-chunk that moves a path
    // must fail here even when the exported constant was updated with it.
  ] as const)("%s", (fieldName, exportedPath, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
    expect(exportedPath).toEqual(compiledPath);
  });
});

describe("the admin-updateable gas parameters sit in chunk 0", () => {
  // These have no exported path constant: nothing reads them by ledger-tree
  // path, only through the generated `ledger()`. They are pinned anyway
  // because WHERE they sit is the whole reason they were declared immediately
  // after signetRequestNonce rather than appended at the end. Fields inserted
  // there push the chunk-1 base down by the same count, which is what leaves
  // the six notification paths above untouched. Appending them instead would
  // have moved all four chunk-1 event maps.
  //
  // The five per-kind gas limits are ONE struct cell, not five fields, and
  // this is where that is enforced: `vaultGasLimits` is a single index.
  it.each([
    ["vaultMaxFeePerGas", [0, 4]],
    ["vaultMaxPriorityFeePerGas", [0, 5]],
    ["vaultGasLimits", [0, 6]],
  ] as const)("%s", (fieldName, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
  });
});

describe("the state tree stays TWO chunks deep", () => {
  // THE CEILING, and the reason vaultGasLimits is one struct cell rather than
  // five separate ledger fields.
  //
  // The compiler packs ledger fields 15 to a node. Up to 30 fields that is two
  // chunks, every compiled index is [chunk, offset], and the request circuits
  // pack the matching requestsPathDepth 2. Field 31 does not extend the second
  // chunk -- it opens a THIRD, and the compiler re-splits from the top: the
  // first chunk keeps ONE field and everything else slides one chunk along.
  // Verified against this compiler by adding six scratch fields: [0,0] stayed,
  // signetRequestNonce moved [0,3] -> [1,2], and all four event maps moved from
  // chunk 1 to chunk 2. Every one of the six paths the MPC notifications pin
  // moves at once.
  //
  // That failure is SILENT. The contract still compiles, the circuits still
  // prove, and the off-chain signer simply stops seeing requests at the paths
  // it watches, with no error raised anywhere. The path assertions above catch
  // the moved paths; these catch the CAUSE, and name it.
  //
  // If a change lands here: do not raise the number. Group related values into
  // one struct cell, the way `vaultGasLimits` holds five gas limits in one
  // field, and the count comes back down.
  it("holds at most 30 fields, the two chunks' worth", () => {
    expect(contractInfo.ledger.length).toBeLessThanOrEqual(30);
  });

  it("uses exactly two chunks, at depth 2", () => {
    const chunks = new Set(contractInfo.ledger.map((field) => field.index[0]));
    const depths = new Set(contractInfo.ledger.map((field) => field.index.length));

    expect([...chunks].sort()).toEqual([0, 1]);
    expect([...depths]).toEqual([2]);
  });
});

describe("the chunk-1 block holds the event maps at their pinned offsets", () => {
  // The sharper tripwire: not just the six notified paths, but the whole of
  // chunk 1 in order. Any ledger field appended at the end, or inserted after
  // depositEventMap, shifts this list and fails here first, naming exactly what
  // moved. The three fields ahead of depositEventMap are the window that slides
  // when a field is declared before it: what must not move is depositEventMap's
  // own offset, and every offset after it.
  it("holds the same 15 fields at the same offsets", () => {
    const chunkOne = contractInfo.ledger
      .filter((field) => field.index[0] === 1)
      .map((field) => [field.name, [...field.index]] as const);

    expect(chunkOne).toEqual([
      ["depositRequestNonces", [1, 0]],
      ["vaultEvmNonce", [1, 1]],
      ["pendingVaultRequests", [1, 2]],
      ["depositEventMap", [1, 3]],
      ["depositSettleViews", [1, 4]],
      ["withdrawSettleViews", [1, 5]],
      ["uniswapRouter", [1, 6]],
      ["swapEventMap", [1, 7]],
      ["swapSettleViews", [1, 8]],
      ["stataUnderlying", [1, 9]],
      ["stataToken", [1, 10]],
      ["supplyEventMap", [1, 11]],
      ["supplySettleViews", [1, 12]],
      ["redeemEventMap", [1, 13]],
      ["redeemSettleViews", [1, 14]],
    ]);
  });

  it("is exactly the last 15 declared fields, so nothing may be appended", () => {
    // The chunking rule itself, pinned: chunk 1 IS the tail of the declaration
    // order. This is the fact every "declare it here, not at the end" comment
    // in erc20-vault.compact rests on.
    const names = contractInfo.ledger.map((field) => field.name);
    const chunkOneNames = contractInfo.ledger
      .filter((field) => field.index[0] === 1)
      .map((field) => field.name);

    expect(chunkOneNames).toHaveLength(15);
    expect(names.slice(-15)).toEqual(chunkOneNames);
  });
});
