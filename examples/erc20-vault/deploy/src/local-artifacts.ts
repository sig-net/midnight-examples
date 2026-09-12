import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseZkArtifactManifest } from "@midnight-ntwrk/midnight-js/utils";
import { REPO_ROOT } from "@sig-net/midnight-examples-lib";
import { verifyManagedTree } from "@sig-net/midnight-examples-lib";

/**
 * Verify deployment code and keys against the UI's installed release manifests.
 *
 * @param uiDirectory - The UI checkout with installed release dependencies.
 * @throws {Error} When source, compiler versions or any deployed artefact differs from the release.
 */
export function assertLocalRelease(uiDirectory: string): void {
  const installed = join(
    uiDirectory,
    "node_modules/@sig-net/midnight-examples-erc20-vault-contract",
  );
  const local = join(REPO_ROOT, "examples/erc20-vault/contract");
  if (
    !readFileSync(join(installed, "src/erc20-vault.compact")).equals(
      readFileSync(join(local, "src/erc20-vault.compact")),
    )
  )
    throw new Error(
      "Vault source differs from the UI release. Align the examples ref and UI dependency before deployment.",
    );
  for (const tree of [
    join(installed, "dist/managed/erc20-vault"),
    join(uiDirectory, "node_modules/@sig-net/midnight-contract/dist/managed"),
  ]) {
    const manifest = parseZkArtifactManifest(
      readFileSync(join(tree, "compiler/contract-manifest.json"), "utf8"),
    );
    if (manifest.files.size === 0) throw new Error("UI release manifest is empty.");
  }
  verifyManagedTree(
    join(uiDirectory, "node_modules/@sig-net/midnight-contract/dist/managed"),
    join(REPO_ROOT, "node_modules/@sig-net/midnight-contract/dist/managed"),
  );
}

/**
 * Verify compiled deployment material against the UI release.
 *
 * @param uiDirectory - UI checkout containing the pinned dependencies.
 * @throws {Error} When a compiled artefact is absent or incompatible.
 */
export function verifyLocalArtifacts(uiDirectory: string): void {
  assertLocalRelease(uiDirectory);
  const installed = join(
    uiDirectory,
    "node_modules/@sig-net/midnight-examples-erc20-vault-contract",
  );
  const local = join(REPO_ROOT, "examples/erc20-vault/contract");
  verifyManagedTree(
    join(installed, "dist/managed/erc20-vault"),
    join(local, "src/managed/erc20-vault"),
  );
}
