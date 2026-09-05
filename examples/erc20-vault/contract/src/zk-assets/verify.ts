// Verification of a served tree and of a regenerated compile against the
// manifest the package ships. Pure over an injected reader, so the checks run
// in tests without a toolchain or a filesystem. Not part of the package's
// export surface.

import {
  computeSha256Hex,
  verifyZkArtifactIntegrity,
  ZK_MANIFEST_DIR,
  ZK_MANIFEST_FILE_NAME,
  ZkArtifactIntegrityError,
  type ZkArtifactManifest,
} from "@midnight-ntwrk/midnight-js/utils";

import { servedEntries } from "./layout.ts";

/** The manifest's own path in a served tree. It cannot list itself, so it is checked by bytes. */
export const MANIFEST_PATH = `${ZK_MANIFEST_DIR}/${ZK_MANIFEST_FILE_NAME}`;

/** Reads one artefact of a tree by its manifest path, `undefined` when the file is absent. */
export type ReadArtifact = (relativePath: string) => Promise<Uint8Array | undefined>;

/** One way a tree fails verification. */
export interface TreeMismatch {
  /** The manifest path of the offending file. */
  readonly relativePath: string;
  /** What is wrong with it: absent, or the integrity error's message. */
  readonly reason: string;
}

/**
 * Check a served tree: its `compiler/contract-manifest.json` must be
 * `manifestBytes` exactly, and every served entry of the manifest those bytes
 * describe must match by size and then sha256, the check the zk config
 * providers apply at fetch time.
 *
 * @param manifest - The parsed manifest the tree must satisfy.
 * @param manifestBytes - The raw bytes the tree's own manifest file must equal.
 * @param readArtifact - Reads a file of the tree under test by manifest path.
 * @returns Every mismatching entry, empty when the tree verifies.
 */
export async function verifyTree(
  manifest: ZkArtifactManifest,
  manifestBytes: Uint8Array,
  readArtifact: ReadArtifact,
): Promise<TreeMismatch[]> {
  const mismatches: TreeMismatch[] = [];
  const servedManifest = await readArtifact(MANIFEST_PATH);
  if (servedManifest === undefined) {
    mismatches.push({ relativePath: MANIFEST_PATH, reason: "missing" });
  } else if (computeSha256Hex(servedManifest) !== computeSha256Hex(manifestBytes)) {
    mismatches.push({ relativePath: MANIFEST_PATH, reason: "differs from the shipped manifest" });
  }
  for (const relativePath of servedEntries(manifest)) {
    const bytes = await readArtifact(relativePath);
    if (bytes === undefined) {
      mismatches.push({ relativePath, reason: "missing" });
      continue;
    }
    try {
      verifyZkArtifactIntegrity({ manifest, relativePath, bytes, mode: "require" });
    } catch (error) {
      if (!(error instanceof ZkArtifactIntegrityError)) throw error;
      mismatches.push({ relativePath, reason: error.message });
    }
  }
  return mismatches;
}

/**
 * Explain why a regenerated compile cannot have produced the shipped
 * artefacts, before any key is hashed: the toolchain versions the two
 * manifests record must agree, and so must `compiler/contract-info.json`,
 * the circuit table both compiles derive their keys from. A difference here
 * names the toolchain as the cause where a bare key hash mismatch would not.
 *
 * @param shipped - The manifest the package ships.
 * @param regenerated - The manifest the local compile wrote.
 * @returns Every disagreement as a sentence, empty when the builds are compatible.
 */
export function explainBuildIncompatibility(
  shipped: ZkArtifactManifest,
  regenerated: ZkArtifactManifest,
): string[] {
  const reasons: string[] = [];
  const versions: readonly [string, string | undefined, string | undefined][] = [
    ["compiler-version", shipped.compilerVersion, regenerated.compilerVersion],
    ["language-version", shipped.languageVersion, regenerated.languageVersion],
    ["runtime-version", shipped.runtimeVersion, regenerated.runtimeVersion],
  ];
  for (const [field, expected, actual] of versions) {
    if (expected !== actual) {
      reasons.push(
        `${field}: the package was built with ${String(expected)}, this compile used ${String(actual)}`,
      );
    }
  }
  const contractInfo = "compiler/contract-info.json";
  const expectedInfo = shipped.files.get(contractInfo);
  const actualInfo = regenerated.files.get(contractInfo);
  if (expectedInfo?.hash !== actualInfo?.hash) {
    reasons.push(`${contractInfo} differs: the compiled circuit table is not the shipped one`);
  }
  return reasons;
}
