// The zk-assets run: lay out the vault's and the signet callee's zk artefacts
// under one directory in the layout a fetch-based zk config provider reads
// (`keys/`, `zkir/`, `compiler/`, and the same under `signet/`). The vault's
// prover keys are regenerated with the pinned toolchain and accepted only when
// every served file matches the manifest this package ships. The callee's
// tree is copied from `@sig-net/midnight-contract`, which ships its provers.
// Not part of the package's export surface.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeSha256Hex,
  parseZkArtifactManifest,
  ZK_MANIFEST_DIR,
  ZK_MANIFEST_FILE_NAME,
  type ZkArtifactManifest,
} from "@midnight-ntwrk/midnight-js/utils";

import {
  COMPACT_COMPILER_VERSION,
  compileWithKeys,
  INSTALL_HINT,
  locatePinnedCompiler,
  reportedCompilerVersion,
  ToolchainError,
} from "./compact-toolchain.ts";
import { hasProverKeys, servedEntries, SIGNET_TREE } from "./layout.ts";
import {
  explainBuildIncompatibility,
  MANIFEST_PATH,
  type ReadArtifact,
  verifyTree,
} from "./verify.ts";

/** A laid-out tree does not match the manifest it must satisfy. Nothing was written. */
export class VerificationFailedError extends Error {}

/** What a run does. */
export interface ZkAssetsOptions {
  /** The directory to lay the trees out in, e.g. a web app's `public/`. */
  readonly outDir: string;
  /** Which trees to produce. */
  readonly trees: { readonly vault: boolean; readonly signet: boolean };
  /** Rebuild a tree that already verifies. */
  readonly force: boolean;
  /** The environment the toolchain runs under. */
  readonly env: Record<string, string | undefined>;
  /** Progress sink, one line per call. */
  readonly log: (line: string) => void;
}

/** The manifest hashes an app pins as `expectedManifestHash`, one per tree produced. */
export interface ZkAssetsResult {
  readonly vaultManifestSha256?: string;
  readonly signetManifestSha256?: string;
}

// This module sits at `<pkg>/src/zk-assets/` in the workspace and at
// `<pkg>/dist/zk-assets/` when installed. `managed/` is a sibling of
// `zk-assets/` in both, and the package root is one level further up.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, "..", "..");
const shippedVaultManaged = resolve(moduleDir, "..", "managed", "erc20-vault");
const vaultSource = join(packageRoot, "src", "erc20-vault.compact");
const requireFromPackage = createRequire(join(packageRoot, "package.json"));

const STAGING_PREFIX = ".erc20-vault-zk-assets.";

async function readManifest(managedDir: string): Promise<{
  manifest: ZkArtifactManifest;
  bytes: Uint8Array;
}> {
  const bytes = await readFile(join(managedDir, ZK_MANIFEST_DIR, ZK_MANIFEST_FILE_NAME));
  return { manifest: parseZkArtifactManifest(new TextDecoder().decode(bytes)), bytes };
}

function readerOver(dir: string): ReadArtifact {
  return async (relativePath) => {
    try {
      return await readFile(join(dir, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
}

// The root directory of an installed package, found by walking up from its
// resolved entry module: the package's exports map need not expose
// package.json, so the specifier itself cannot be resolved to it.
function packageDirOf(specifier: string): string {
  let dir = dirname(requireFromPackage.resolve(specifier));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${specifier}'s entry module`);
    dir = parent;
  }
}

async function packageVersion(dir: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error(`${dir}/package.json declares no version`);
  }
  const { version } = manifest;
  if (typeof version !== "string") throw new Error(`${dir}/package.json version is not a string`);
  return version;
}

// The version this package's own manifest pins `name` to.
async function pinnedDependency(name: string): Promise<string | undefined> {
  const own: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (typeof own !== "object" || own === null || !("dependencies" in own)) return undefined;
  const { dependencies } = own;
  if (typeof dependencies !== "object" || dependencies === null) return undefined;
  const pinned: unknown = (dependencies as Record<string, unknown>)[name];
  return typeof pinned === "string" ? pinned : undefined;
}

// The node_modules the compiler resolves `@sig-net/midnight/src/Signet` from:
// the one holding the copy this package depends on, which under an isolated
// or nested install is not the consumer's top-level node_modules.
async function resolveCompactPath(): Promise<string> {
  const midnightDir = packageDirOf("@sig-net/midnight");
  if (!existsSync(join(midnightDir, "src", "Signet.compact"))) {
    throw new ToolchainError(
      `${midnightDir} ships no src/Signet.compact, the vault's Compact import`,
    );
  }
  const pinned = await pinnedDependency("@sig-net/midnight");
  const installed = await packageVersion(midnightDir);
  if (pinned !== undefined && pinned !== installed) {
    throw new ToolchainError(
      `@sig-net/midnight resolves to ${installed} at ${midnightDir}, but this package pins ${pinned}: ` +
        "the compile would read a different Signet.compact than the shipped artefacts were built from",
    );
  }
  return dirname(dirname(midnightDir));
}

// The pinned release must be installed and must report the compiler version
// the shipped manifest records. The launcher's version directory is the only
// place the -rc suffix of the pin is visible.
async function assertToolchain(
  options: ZkAssetsOptions,
  shipped: ZkArtifactManifest,
): Promise<void> {
  const compiler = locatePinnedCompiler(options.env);
  if (compiler === undefined) {
    throw new ToolchainError(
      `compactc ${COMPACT_COMPILER_VERSION} is not installed: ${INSTALL_HINT}`,
    );
  }
  options.log(`pinned compiler: ${compiler}`);
  const reported = await reportedCompilerVersion(options.env);
  options.log(`compact compile +${COMPACT_COMPILER_VERSION} --version: ${reported}`);
  if (reported !== shipped.compilerVersion) {
    throw new ToolchainError(
      `the installed ${COMPACT_COMPILER_VERSION} reports compiler version ${reported}, but the shipped ` +
        `artefacts were built with ${String(shipped.compilerVersion)}: ${INSTALL_HINT}`,
    );
  }
}

async function sweepStaging(outDir: string): Promise<void> {
  if (!existsSync(outDir)) return;
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith(STAGING_PREFIX)) await rm(join(outDir, entry), { recursive: true });
  }
}

// Move the staged top-level directories into place one rename each, parking
// the previous directory beside it until the new one is in.
async function swapIn(stageDir: string, destDir: string, uuid: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const name of await readdir(stageDir)) {
    const target = join(destDir, name);
    const parked = join(destDir, `.${name}.old.${uuid}`);
    if (existsSync(target)) await rename(target, parked);
    await rename(join(stageDir, name), target);
    if (existsSync(parked)) await rm(parked, { recursive: true });
  }
}

// Stage every served entry of `manifest` from `fromDir`, moved (renamed) or
// copied, plus the manifest file itself as `manifestBytes`.
async function stageServedEntries(
  manifest: ZkArtifactManifest,
  manifestBytes: Uint8Array,
  fromDir: string,
  stageDir: string,
  move: boolean,
): Promise<void> {
  for (const relativePath of servedEntries(manifest)) {
    const target = join(stageDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    if (move) {
      await rename(join(fromDir, relativePath), target);
    } else {
      await writeFile(target, await readFile(join(fromDir, relativePath)));
    }
  }
  await writeFile(join(stageDir, MANIFEST_PATH), manifestBytes);
}

async function assertStageVerifies(
  what: string,
  shipped: { manifest: ZkArtifactManifest; bytes: Uint8Array },
  stageDir: string,
  destDir: string,
): Promise<void> {
  const mismatches = await verifyTree(shipped.manifest, shipped.bytes, readerOver(stageDir));
  if (mismatches.length === 0) return;
  const lines = mismatches.map((m) => `  ${m.relativePath}: ${m.reason}`).join("\n");
  throw new VerificationFailedError(
    `${what}: the produced tree does not match the shipped manifest, nothing was written to ${destDir}\n${lines}`,
  );
}

async function produceVault(
  options: ZkAssetsOptions,
  stagingRoot: string,
  uuid: string,
): Promise<string> {
  const shipped = await readManifest(shippedVaultManaged);
  if (!hasProverKeys(shipped.manifest)) {
    throw new ToolchainError(
      `${shippedVaultManaged} holds a --skip-zk compile with no prover keys: run \`yarn compile:erc20-vault:zk\` first`,
    );
  }
  const sha256 = computeSha256Hex(shipped.bytes);
  const existing = await verifyTree(shipped.manifest, shipped.bytes, readerOver(options.outDir));
  if (existing.length === 0 && !options.force) {
    options.log(
      `vault: up to date (${String(servedEntries(shipped.manifest).length)} files verify against the shipped manifest), skipped`,
    );
    return sha256;
  }

  await assertToolchain(options, shipped.manifest);
  const compactPath = await resolveCompactPath();
  options.log(`COMPACT_PATH: ${compactPath}`);
  const buildDir = join(stagingRoot, "build", "erc20-vault");
  options.log(`vault: regenerating with compactc ${COMPACT_COMPILER_VERSION} (this takes minutes)`);
  await compileWithKeys(vaultSource, buildDir, compactPath, packageRoot, options.env);

  const regenerated = await readManifest(buildDir);
  const incompatible = explainBuildIncompatibility(shipped.manifest, regenerated.manifest);
  if (incompatible.length > 0) {
    throw new VerificationFailedError(
      `vault: the regenerated compile is not the shipped one, nothing was written to ${options.outDir}\n` +
        incompatible.map((reason) => `  ${reason}`).join("\n"),
    );
  }

  const stageDir = join(stagingRoot, "stage", "vault");
  // The served manifest is the shipped one, byte for byte, so its hash is
  // the stable value an app pins, while the build's own copy carries source-map
  // hashes that depend on where it was compiled.
  await stageServedEntries(shipped.manifest, shipped.bytes, buildDir, stageDir, true);
  await assertStageVerifies("vault", shipped, stageDir, options.outDir);
  await swapIn(stageDir, options.outDir, uuid);
  options.log(`vault: installed ${String(servedEntries(shipped.manifest).length)} files`);
  return sha256;
}

async function produceSignet(
  options: ZkAssetsOptions,
  stagingRoot: string,
  uuid: string,
): Promise<string> {
  const signetManaged = join(packageDirOf("@sig-net/midnight-contract"), "dist", "managed");
  const shipped = await readManifest(signetManaged);
  const sha256 = computeSha256Hex(shipped.bytes);
  const destDir = join(options.outDir, SIGNET_TREE);
  const existing = await verifyTree(shipped.manifest, shipped.bytes, readerOver(destDir));
  if (existing.length === 0 && !options.force) {
    options.log(
      `signet: up to date (${String(servedEntries(shipped.manifest).length)} files verify against its manifest), skipped`,
    );
    return sha256;
  }
  const stageDir = join(stagingRoot, "stage", SIGNET_TREE);
  options.log(`signet: copying from ${signetManaged}`);
  await stageServedEntries(shipped.manifest, shipped.bytes, signetManaged, stageDir, false);
  await assertStageVerifies("signet", shipped, stageDir, destDir);
  await swapIn(stageDir, destDir, uuid);
  options.log(`signet: installed ${String(servedEntries(shipped.manifest).length)} files`);
  return sha256;
}

/**
 * Lay out the zk assets under `options.outDir`: `keys/`, `zkir/` and
 * `compiler/` for the vault, the same under {@link SIGNET_TREE} for the
 * signet callee. A
 * tree that already verifies is left alone unless forced. Each tree is
 * swapped in only after it verifies, one directory rename at a time, so a
 * failed run never leaves a half-written tree in place.
 *
 * @param options - What to produce and where.
 * @returns The sha256 of each produced tree's manifest, for the app to pin.
 * @throws {ToolchainError} If the pinned toolchain or the Compact sources are not usable.
 * @throws {CompileFailedError} If the compiler fails.
 * @throws {VerificationFailedError} If a produced tree does not match its manifest.
 */
export async function runZkAssets(options: ZkAssetsOptions): Promise<ZkAssetsResult> {
  // The compiler runs with the package root as cwd, so a relative outDir must be
  // absolute before any path derived from it reaches the compiler.
  const anchored: ZkAssetsOptions = { ...options, outDir: resolve(options.outDir) };
  await mkdir(anchored.outDir, { recursive: true });
  await sweepStaging(anchored.outDir);
  const uuid = randomUUID();
  const stagingRoot = join(anchored.outDir, `${STAGING_PREFIX}${uuid}`);
  await mkdir(stagingRoot, { recursive: true });
  try {
    const result: { vaultManifestSha256?: string; signetManifestSha256?: string } = {};
    if (anchored.trees.vault)
      result.vaultManifestSha256 = await produceVault(anchored, stagingRoot, uuid);
    if (anchored.trees.signet) {
      result.signetManifestSha256 = await produceSignet(anchored, stagingRoot, uuid);
    }
    return result;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
