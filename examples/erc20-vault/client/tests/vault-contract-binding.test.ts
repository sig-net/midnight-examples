// The binding resolves the contract package's compiler output through the
// PACKAGE SPECIFIER, so it keeps working wherever the consumer lives. A wrong
// path fails late and obscurely (a proof server that cannot find a key, a
// deploy with no verifier keys), so lock it here: these run without any
// compile:zk output, only the default `yarn compile` managed dir.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SIGNET_SIGNER_MANAGED_PATH, VAULT_MANAGED_PATH } from "../src/vault-contract-binding.ts";

describe("vault contract binding", () => {
  it("resolves the vault's compiler output inside the contract package", () => {
    expect(VAULT_MANAGED_PATH).toMatch(/erc20-vault\/contract\/src\/managed\/erc20-vault$/);
    expect(existsSync(join(VAULT_MANAGED_PATH, "contract")), `run \`yarn compile\` first`).toBe(
      true,
    );
  });

  it("resolves the signet callee's compiler output (the compile-time symlink)", () => {
    expect(SIGNET_SIGNER_MANAGED_PATH).toMatch(
      /erc20-vault\/contract\/src\/managed\/SignetSigner$/,
    );
    expect(existsSync(join(SIGNET_SIGNER_MANAGED_PATH, "zkir")), `run \`yarn compile\` first`).toBe(
      true,
    );
  });
});
