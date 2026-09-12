// The subset of a compiled contract's managed/ output a fetch-based zk config
// provider reads, and the directory layout it is served from. Pure: the
// manifest in, relative paths out. Not part of the package's export surface.

import type { ZkArtifactManifest } from "@midnight-ntwrk/midnight-js/utils";

/** Subdirectory of the output holding the signet callee contract's tree. */
export const SIGNET_TREE = "signet";

/** The top-level directories a served tree holds, the ones a run swaps into place. */
export const SERVED_TOP_LEVEL_DIRS = ["keys", "zkir", "compiler"] as const;

/** Prefix of a run's staging directory under the output, `<prefix><run uuid>`. */
export const STAGING_PREFIX = ".erc20-vault-zk-assets.";

/**
 * Where a swap parks the directory it replaces until the new one is in:
 * `.<dir>.old.<run uuid>`, beside the directory itself.
 *
 * @param dir - The top-level directory being replaced.
 * @param runUuid - The run doing the replacing.
 * @returns The parked directory's name.
 */
export function parkedName(dir: string, runUuid: string): string {
  return `.${dir}.old.${runUuid}`;
}

const PARKED_PATTERN = new RegExp(
  `^\\.(${SERVED_TOP_LEVEL_DIRS.join("|")})\\.old\\.[0-9a-f-]{36}$`,
);

/**
 * Whether a directory entry is a leftover of an earlier run that was killed
 * mid-way: its staging directory, or a directory it parked and never removed.
 * Entries carrying `currentRunUuid` belong to the run in progress.
 *
 * @param entryName - A name from the output directory's listing.
 * @param currentRunUuid - The uuid of the run asking.
 * @returns Whether the entry is safe to remove before this run proceeds.
 */
export function isRunLeftover(entryName: string, currentRunUuid: string): boolean {
  if (entryName.endsWith(currentRunUuid)) return false;
  return entryName.startsWith(STAGING_PREFIX) || PARKED_PATTERN.test(entryName);
}

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
