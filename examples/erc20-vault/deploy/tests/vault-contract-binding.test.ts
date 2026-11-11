// The binding resolves the contract package's compiler output through the
// PACKAGE SPECIFIER, so it keeps working wherever the consumer lives. A wrong
// path fails late and obscurely (a proof server that cannot find a key, a
// deploy with no verifier keys), so lock it here: this runs without any
// compile:zk output, only the default `yarn compile` managed dir.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertVaultKeysPresent, VAULT_MANAGED_PATH } from "../src/vault-contract-binding.ts";

const HAS_KEYS = existsSync(join(VAULT_MANAGED_PATH, "keys"));

describe("vault contract binding", () => {
  it("resolves the vault's compiler output inside the contract package", () => {
    expect(VAULT_MANAGED_PATH).toMatch(/erc20-vault\/contract\/src\/managed\/erc20-vault$/);
    expect(existsSync(join(VAULT_MANAGED_PATH, "contract")), `run \`yarn compile\` first`).toBe(
      true,
    );
  });

  it.skipIf(HAS_KEYS)("names the fix when the compile wrote no keys", () => {
    expect(() => {
      assertVaultKeysPresent();
    }).toThrow(/no zk keys under .*managed\/erc20-vault: run `yarn compile:erc20-vault:zk` first/);
  });

  it.skipIf(!HAS_KEYS)("accepts a compile that wrote keys", () => {
    expect(() => {
      assertVaultKeysPresent();
    }).not.toThrow();
  });
});
