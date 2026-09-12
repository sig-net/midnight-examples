import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseZkArtifactManifest,
  verifyZkArtifactIntegrity,
} from "@midnight-ntwrk/midnight-js/utils";

/**
 * Require non-empty proving material and verify deployment files against a release manifest.
 *
 * @param releaseTree - Directory containing the reference compiler manifest.
 * @param deploymentTree - Directory containing the files that will be deployed.
 * @throws {Error} When compiler versions differ or a required artefact fails integrity verification.
 */
export function verifyManagedTree(releaseTree: string, deploymentTree: string): void {
  const release = parseZkArtifactManifest(
    readFileSync(join(releaseTree, "compiler/contract-manifest.json"), "utf8"),
  );
  const compiled = parseZkArtifactManifest(
    readFileSync(join(deploymentTree, "compiler/contract-manifest.json"), "utf8"),
  );
  if (
    release.compilerVersion !== compiled.compilerVersion ||
    release.runtimeVersion !== compiled.runtimeVersion ||
    release.languageVersion !== compiled.languageVersion
  )
    throw new Error("Compiled toolchain versions differ from the reference release.");
  const files = [...release.files.keys()].filter((path) => !path.endsWith(".map"));
  if (files.length === 0 || !files.some((path) => path.endsWith(".prover")))
    throw new Error("Release manifest contains no proving artefacts.");
  for (const relativePath of files)
    verifyZkArtifactIntegrity({
      manifest: release,
      relativePath,
      bytes: readFileSync(join(deploymentTree, relativePath)),
      mode: "require",
    });
}
