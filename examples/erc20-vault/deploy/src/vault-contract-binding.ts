// The vault's Node binding: the compiler-output directories on disk and the
// compact-js compiled contract they back. Everything downstream (the deploy
// transaction, the provider set, the proof server's key lookups) resolves its
// assets through here, so there is one answer to "where is managed/".

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { makeCompiledContract } from "@sig-net/midnight-contract-deploy";
import {
  Contract,
  type VaultPrivateState,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { VAULT_CONTRACT_ENTRY_DIR } from "./vault-contract-package.ts";

// Resolved through the PACKAGE SPECIFIER like {@link VAULT_CONTRACT_ENTRY_DIR}:
// the entry module sits beside the package's own managed/ output.
const signetContractEntryDir = dirname(
  createRequire(import.meta.url).resolve("@sig-net/midnight-contract"),
);

/** Absolute path of the vault contract's compiler output dir (`contract/`, `zkir/`, `keys/`). */
export const VAULT_MANAGED_PATH = join(VAULT_CONTRACT_ENTRY_DIR, "managed/erc20-vault");

/**
 * Absolute path of the signet callee contract's compiler output dir. The vault's
 * request circuits cross-contract-call the signet contract, so proving spans
 * both, and the callee's assets come from the SDK package that owns them:
 * `@sig-net/midnight-contract` ships its own compiled managed/ output.
 */
export const SIGNET_SIGNER_MANAGED_PATH = join(signetContractEntryDir, "managed");

/**
 * The vault's compact-js compiled-contract binding: generated module + real
 * witnesses + the contract package's compiled assets. Consumed by the deploy
 * transaction builders and by `findDeployedContract`.
 */
export const vaultCompiledContract = makeCompiledContract<
  Contract<VaultPrivateState>,
  VaultPrivateState
>("erc20-vault", Contract, witnesses, VAULT_MANAGED_PATH);
