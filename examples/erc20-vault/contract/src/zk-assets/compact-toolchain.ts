// The pinned compact toolchain as the zk-assets bin drives it: where the
// launcher keeps the pinned compiler, how its version is read, and the one
// compile invocation that regenerates the vault's managed/ output. Not part
// of the package's export surface.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The compactc release the shipped artefacts were built with. Keygen is
 * deterministic under one toolchain, so a consumer's regenerated keys match
 * the shipped manifest only when this exact release compiles them. Part of
 * the workspace's toolchain pin, which moves together with the workflows'
 * launcher and compiler URLs and the README's prerequisites table.
 */
export const COMPACT_COMPILER_VERSION = "0.33.0-rc.2";

/** The launcher's own release, named in the fix printed when the compiler is missing. */
export const COMPACT_LAUNCHER_VERSION = "compact-v0.5.1";

/** The toolchain is absent, the wrong release, or refuses to run. */
export class ToolchainError extends Error {}

/** The compiler ran and exited non-zero. */
export class CompileFailedError extends Error {}

/**
 * The launcher's artefact directory, `COMPACT_DIRECTORY` or `~/.compact`.
 *
 * @param env - The environment to read `COMPACT_DIRECTORY` from.
 * @returns The absolute directory path.
 */
export function compactDirectory(env: Record<string, string | undefined>): string {
  const configured = env.COMPACT_DIRECTORY?.trim();
  return configured === undefined || configured === "" ? join(homedir(), ".compact") : configured;
}

/**
 * Where the launcher keeps the pinned compiler: `<compact dir>/versions/<version>/<arch>/compactc`.
 * `compact compile --version` prints the release without its `-rc.N` suffix,
 * so this directory is the only place the exact pin is visible.
 *
 * @param env - The environment to read `COMPACT_DIRECTORY` from.
 * @returns The compiler binary's path, or `undefined` when the pinned release is not installed.
 */
export function locatePinnedCompiler(env: Record<string, string | undefined>): string | undefined {
  const versionDir = join(compactDirectory(env), "versions", COMPACT_COMPILER_VERSION);
  if (!existsSync(versionDir)) return undefined;
  for (const arch of readdirSync(versionDir)) {
    const binary = join(versionDir, arch, "compactc");
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

/** How to install the pinned release, printed by every toolchain failure. */
export const INSTALL_HINT =
  `install the compact launcher ${COMPACT_LAUNCHER_VERSION} and run ` +
  `\`compact update ${COMPACT_COMPILER_VERSION}\`. The release is a prerelease the launcher's ` +
  "channel may not list: download it from the Compact repository's release page into " +
  `<compact dir>/versions/${COMPACT_COMPILER_VERSION}/<arch>/ and rerun \`compact update\`.`;

/**
 * Run `compact compile +<pin> <args>` with the launcher on `PATH`, streaming
 * the compiler's output to this process's stdio when `inherit` is set.
 *
 * @param args - Arguments after the version selector.
 * @param options - How the child runs.
 * @param options.cwd - The child's working directory.
 * @param options.env - The child's environment.
 * @param options.inherit - Stream the child's stdio to this process instead of capturing it.
 * @returns The captured stdout when stdio is captured, otherwise the empty string.
 * @throws {ToolchainError} If the launcher is not on `PATH`.
 * @throws {CompileFailedError} If the compiler exits non-zero.
 */
export function runCompactCompile(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly inherit: boolean;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("compact", ["compile", `+${COMPACT_COMPILER_VERSION}`, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new ToolchainError(`the compact launcher is not on PATH: ${INSTALL_HINT}`)
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new CompileFailedError(
          `compact compile exited with code ${String(code)}${stderr ? `\n${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

/**
 * The release string the pinned compiler reports, e.g. `0.33.0`.
 *
 * @param env - The environment the launcher runs under.
 * @returns The trimmed output of `compact compile +<pin> --version`.
 * @throws {ToolchainError} If the launcher is not on `PATH` or the pinned release cannot run.
 */
export async function reportedCompilerVersion(
  env: Record<string, string | undefined>,
): Promise<string> {
  try {
    return (
      (await runCompactCompile(["--version"], { cwd: process.cwd(), env, inherit: false }))
        .trim()
        .split("\n")
        .at(-1)
        ?.trim() ?? ""
    );
  } catch (error) {
    if (error instanceof CompileFailedError) {
      throw new ToolchainError(
        `the pinned compiler ${COMPACT_COMPILER_VERSION} does not run: ${error.message}. ${INSTALL_HINT}`,
      );
    }
    throw error;
  }
}

/**
 * Compile `source` into `target` with the pinned compiler, zk keys included,
 * resolving Compact imports through `compactPath`.
 *
 * @param source - The `.compact` file to compile.
 * @param target - The managed/ directory the compiler writes.
 * @param compactPath - The `COMPACT_PATH` entry, a `node_modules` holding `@sig-net/midnight`.
 * @param cwd - The directory the compiler runs in (its diagnostics are relative to it).
 * @param env - The environment to extend with `COMPACT_PATH`.
 * @throws {ToolchainError} If the launcher is not on `PATH`.
 * @throws {CompileFailedError} If the compiler exits non-zero.
 */
export async function compileWithKeys(
  source: string,
  target: string,
  compactPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  await runCompactCompile(["--feature-zkir-v3", source, target], {
    cwd,
    env: { ...env, COMPACT_PATH: compactPath },
    inherit: true,
  });
}
