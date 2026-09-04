// The vault's Node binding: the compiler-output directories on disk and the
// compact-js compiled contract they back. Everything downstream (the deploy
// transaction, the provider set, the proof server's key lookups) resolves its
// assets through here, so there is one answer to "where is managed/".

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  Contract,
  type VaultPrivateState,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { makeCompiledContract } from "@sig-net/midnight-examples-lib";

// Both resolved through the PACKAGE SPECIFIER rather than a relative path:
// each package's entry module sits beside its own managed/ output, so this
// keeps working wherever the consumer lives: workspace member or installed
// dependency, whose entry is the emitted dist/. `createRequire` rather than
// `import.meta.resolve`, which vitest's module runner does not implement.
const resolveFromHere = createRequire(import.meta.url);
const vaultContractEntryDir = dirname(
  resolveFromHere.resolve("@sig-net/midnight-examples-erc20-vault-contract"),
);
const signetContractEntryDir = dirname(resolveFromHere.resolve("@sig-net/midnight-contract"));

/** Absolute path of the vault contract's compiler output dir (`contract/`, `zkir/`, `keys/`). */
export const VAULT_MANAGED_PATH = join(vaultContractEntryDir, "managed/erc20-vault");

/**
 * Absolute path of the signet callee contract's compiler output dir. The vault's
 * request circuits cross-contract-call the signet contract, so proving spans
 * both, and the callee's assets come from the SDK package that owns them:
 * `@sig-net/midnight-contract` ships its own compiled managed/ output.
 */
export const SIGNET_SIGNER_MANAGED_PATH = join(signetContractEntryDir, "managed");

// The manifest is read off disk rather than resolved as `.../package.json`:
// the contract package's exports map covers "." and "./managed/*" only, so the
// specifier does not resolve. The entry module sits one level below the
// package root in both layouts (workspace `src/index.ts`, installed
// `dist/index.js`), which is what makes the "../package.json" hop correct.
function readVaultContractPackageVersion(): string {
  const manifestPath = join(vaultContractEntryDir, "..", "package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error(`${manifestPath} declares no version`);
  }
  const { version } = manifest;
  if (typeof version !== "string") {
    throw new Error(`${manifestPath} declares a non-string version`);
  }
  return version;
}

/**
 * Version of the erc20-vault contract package backing {@link VAULT_MANAGED_PATH}.
 * Prover keys are published as assets on that version's release tag, so the
 * release-backed key provider needs it to name the assets it downloads.
 *
 * `"0.0.0"` is the workspace placeholder every member carries between releases:
 * no release exists for it, and locally compiled keys are the only source.
 */
export const VAULT_CONTRACT_PACKAGE_VERSION: string = readVaultContractPackageVersion();

/**
 * The vault's compact-js compiled-contract binding: generated module + real
 * witnesses + the contract package's compiled assets. Consumed by the deploy
 * transaction builders and by `findDeployedContract`.
 */
export const vaultCompiledContract = makeCompiledContract<
  Contract<VaultPrivateState>,
  VaultPrivateState
>("erc20-vault", Contract, witnesses, VAULT_MANAGED_PATH);
