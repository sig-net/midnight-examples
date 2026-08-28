// The vault's Node binding: the compiler-output directories on disk and the
// compact-js compiled contract they back. Everything downstream (the deploy
// transaction, the provider set, the proof server's key lookups) resolves its
// assets through here, so there is one answer to "where is managed/".

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  Contract,
  type VaultPrivateState,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { makeCompiledContract } from "@sig-net/midnight-examples-lib";

// Resolved through the PACKAGE SPECIFIER rather than a relative path: the
// contract package's entry module sits beside its managed/ output, so this
// keeps working wherever the consumer lives. `createRequire` rather than
// `import.meta.resolve`, which vitest's module runner does not implement.
const contractEntryDir = dirname(
  createRequire(import.meta.url).resolve("@sig-net/midnight-examples-erc20-vault-contract"),
);

/** Absolute path of the vault contract's compiler output dir (`contract/`, `zkir/`, `keys/`). */
export const VAULT_MANAGED_PATH = join(contractEntryDir, "managed/erc20-vault");

/**
 * Absolute path of the signet callee contract's compiler output dir. The vault's
 * request circuits cross-contract-call the signet contract, so proving spans
 * both; the contract package's compile script symlinks this to the published
 * signet contract's managed output.
 */
export const SIGNET_SIGNER_MANAGED_PATH = join(contractEntryDir, "managed/SignetSigner");

/**
 * The vault's compact-js compiled-contract binding: generated module + real
 * witnesses + the contract package's compiled assets. Consumed by the deploy
 * transaction builders and by `findDeployedContract`.
 */
export const vaultCompiledContract = makeCompiledContract<
  Contract<VaultPrivateState>,
  VaultPrivateState
>("erc20-vault", Contract, witnesses, VAULT_MANAGED_PATH);
