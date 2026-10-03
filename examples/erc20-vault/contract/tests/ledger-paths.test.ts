// Pins each exported event-map path constant to the compiler's recorded field index.
// Any ledger declaration change re-chunks the state tree and can move every path, so
// this is the tripwire that turns that drift into a unit-test failure instead of an MPC
// that never answers requests.

import { describe, expect, it } from "vitest";

import {
  VAULT_APPROVE_REQUESTS_PATH,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_REDEEM_REQUESTS_PATH,
  VAULT_REPLACE_NONCE_REQUESTS_PATH,
  VAULT_SUPPLY_REQUESTS_PATH,
  VAULT_SWAP_REQUESTS_PATH,
  VAULT_WITHDRAW_REQUESTS_PATH,
} from "../src/index.ts";
import { compiledFieldIndex } from "./compiled-ledger.ts";

describe("exported ledger paths match the compiled contract-info.json", () => {
  it.each([
    ["bidirectionalDepositMap", VAULT_DEPOSIT_REQUESTS_PATH, [2, 5]],
    ["bidirectionalWithdrawMap", VAULT_WITHDRAW_REQUESTS_PATH, [2, 7]],
    ["bidirectionalApproveMap", VAULT_APPROVE_REQUESTS_PATH, [2, 3]],
    ["bidirectionalReplaceNonceMap", VAULT_REPLACE_NONCE_REQUESTS_PATH, [2, 1]],
    ["bidirectionalSwapMap", VAULT_SWAP_REQUESTS_PATH, [2, 9]],
    ["bidirectionalSupplyMap", VAULT_SUPPLY_REQUESTS_PATH, [2, 11]],
    ["bidirectionalRedeemMap", VAULT_REDEEM_REQUESTS_PATH, [2, 13]],
    // The literal column is deliberate: the notification vectors in
    // erc20-vault.compact are hand-written, so a re-chunk that moves a path
    // must fail here even when the exported constant was updated with it.
  ] as const)("%s", (fieldName, exportedPath, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
    expect(exportedPath).toEqual(compiledPath);
  });
});
