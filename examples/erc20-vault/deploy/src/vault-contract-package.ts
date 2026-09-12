// Where the vault contract package's entry module lives, resolved through the
// PACKAGE SPECIFIER so the path follows whatever layout the package's `exports`
// entry names (`src/` in the workspace, `dist/` when installed). Resolving
// never loads the entry, so importing this module is safe on a checkout
// without compiled managed/ output. `createRequire` because vitest's module
// runner does not implement `import.meta.resolve`.

import { createRequire } from "node:module";
import { dirname } from "node:path";

/** Absolute path of the directory holding the vault contract package's entry module. */
export const VAULT_CONTRACT_ENTRY_DIR = dirname(
  createRequire(import.meta.url).resolve("@sig-net/midnight-examples-erc20-vault-contract"),
);
