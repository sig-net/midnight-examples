// The vault's Node binding: the compiler-output directories on disk and the
// compact-js compiled contract they back. Everything downstream (the deploy
// transaction, the provider set, the proof server's key lookups) resolves its
// assets through here, so there is one answer to "where is managed/".

import { existsSync } from "node:fs";
import { join } from "node:path";

import { makeCompiledContract } from "@sig-net/midnight-contract-deploy";
import {
  Contract,
  type VaultPrivateState,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { VAULT_CONTRACT_ENTRY_DIR } from "./vault-contract-package.ts";

/**
 * Absolute path of the vault contract's compiler output dir (`contract/`, `zkir/`, `keys/`).
 * The signet callee's is the deploy SDK's `signetSignerManagedPath`.
 */
export const VAULT_MANAGED_PATH = join(VAULT_CONTRACT_ENTRY_DIR, "managed/erc20-vault");

/**
 * The vault's compact-js compiled-contract binding: generated module + real
 * witnesses + the contract package's compiled assets. Consumed by the deploy
 * transaction builders and by `findDeployedContract`.
 */
export const vaultCompiledContract = makeCompiledContract<
  Contract<VaultPrivateState>,
  VaultPrivateState
>("erc20-vault", Contract, witnesses, VAULT_MANAGED_PATH);

/**
 * Assert the vault's compiler output holds its zk keys. A `--skip-zk` compile writes none, and
 * the missing files otherwise surface as a read error inside the SDK only once a wallet has
 * synced.
 *
 * @throws {Error} If {@link VAULT_MANAGED_PATH} has no `keys/` directory.
 */
export function assertVaultKeysPresent(): void {
  if (!existsSync(join(VAULT_MANAGED_PATH, "keys"))) {
    throw new Error(
      `no zk keys under ${VAULT_MANAGED_PATH}: run \`yarn compile:erc20-vault:zk\` first`,
    );
  }
}
