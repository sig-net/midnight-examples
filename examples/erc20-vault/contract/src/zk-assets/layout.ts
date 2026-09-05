// The subset of a compiled contract's managed/ output a fetch-based zk config
// provider reads, and the directory layout it is served from. Pure: the
// manifest in, relative paths out. Not part of the package's export surface.

import type { ZkArtifactManifest } from "@midnight-ntwrk/midnight-js/utils";

/** Subdirectory of the output holding the signet callee contract's tree. */
export const SIGNET_TREE = "signet";

/**
 * Whether a manifest entry is one a zk config provider fetches: every key,
 * every binary zkir and every compiler file. The text `.zkir` and the
 * generated `contract/` module are never requested, so they stay out of a
 * served tree.
 *
 * @param relativePath - A manifest key, `<dir>/<file>`.
 * @returns Whether the file belongs in a served tree.
 */
export function isServedEntry(relativePath: string): boolean {
  if (relativePath.startsWith("keys/") || relativePath.startsWith("compiler/")) return true;
  return relativePath.startsWith("zkir/") && relativePath.endsWith(".bzkir");
}

/**
 * The relative paths a served tree must hold for `manifest`, sorted.
 *
 * @param manifest - The parsed `compiler/contract-manifest.json` of the compiled contract.
 * @returns Every served entry of the manifest, `<dir>/<file>`, in sorted order.
 */
export function servedEntries(manifest: ZkArtifactManifest): string[] {
  return [...manifest.files.keys()].filter(isServedEntry).sort();
}

/**
 * Whether a manifest describes a full zk compile: one that emitted prover
 * keys. A `--skip-zk` compile writes a manifest without a `keys/` section.
 *
 * @param manifest - The parsed manifest to inspect.
 * @returns Whether at least one `keys/*.prover` entry is present.
 */
export function hasProverKeys(manifest: ZkArtifactManifest): boolean {
  return [...manifest.files.keys()].some(
    (relativePath) => relativePath.startsWith("keys/") && relativePath.endsWith(".prover"),
  );
}
