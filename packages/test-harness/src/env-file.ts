// Append-only writer for the repo-root `.env`, used by the setup steps that
// hand values to docker compose. Append-only BY DESIGN: the file is
// hand-edited by operators, and an append can never corrupt or reorder what
// they wrote. Reading is lib's `loadRepoDotEnv`, which every entrypoint (not
// just the suite) starts from.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotEnv, REPO_ROOT } from "@sig-net/midnight-examples-lib";

/**
 * Append `KEY=value` lines to the repo-root `.env` under a one-line `#`
 * provenance comment, creating the file when missing. STRICTLY append-only:
 * existing lines are never read, reordered, or rewritten, so this call
 * cannot corrupt a hand-edited file. Presence and conflict checks are the
 * CALLER's job (via lib's `loadRepoDotEnv`). Never append a key the file
 * already holds: that reader and docker compose both take a key's last
 * occurrence, so an appended duplicate silently overrides the operator's
 * hand-edited value instead of failing.
 *
 * @param entries - The KEY=value pairs to append, in iteration order.
 * @param provenance - One-line note of who wrote the block and why.
 * @param filePath - The env file to append to; defaults to the repo-root
 *   `.env` (overridable so tests can target a scratch file).
 */
export function appendRepoDotEnv(
  entries: Record<string, string>,
  provenance: string,
  filePath: string = join(REPO_ROOT, ".env"),
): void {
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  appendFileSync(filePath, `\n# ${provenance}\n${lines.join("\n")}\n`, "utf8");
}

/**
 * Persist the run's values of `keys` to the repo-root `.env`, append-only.
 * Each key is checked against the FILE (not the process env): absent from
 * `env` → ignored; already in the file with the run's value → nothing to do;
 * absent from the file → appended under `provenance` via
 * {@link appendRepoDotEnv}; present with a DIFFERENT value → hard error,
 * because the reader and docker compose both take a key's last occurrence,
 * so appending would silently override the operator's hand-edited value
 * while this run used another.
 *
 * @param env - The run's env accumulator (holds the values to persist).
 * @param keys - The env-var names to persist, in write order.
 * @param provenance - One-line note of who wrote the block and why.
 * @param filePath - The env file to append to; defaults to the repo-root
 *   `.env` (overridable so tests can target a scratch file).
 * @returns The keys appended this call, in write order (empty when every key
 *   was already in the file or absent from `env`).
 * @throws {Error} If the file holds one of `keys` with a value different from the run's.
 */
export function persistToDotEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  provenance: string,
  filePath: string = join(REPO_ROOT, ".env"),
): string[] {
  let fileText: string;
  try {
    fileText = readFileSync(filePath, "utf8");
  } catch {
    fileText = "";
  }
  const fileEnv = parseDotEnv(fileText);
  const toAppend: Record<string, string> = {};
  for (const key of keys) {
    const runValue = env[key];
    if (runValue === undefined) continue;
    const fileValue = fileEnv[key];
    if (fileValue === runValue) continue;
    if (fileValue !== undefined) {
      throw new Error(
        `${key} conflicts: this run uses ${runValue} (from your shell environment) but .env holds ${fileValue}.` +
          ` The reader and docker compose both take a key's last occurrence, so appending would silently override the file.` +
          ` Reconcile the two (usually: update .env and unset the shell override), then rerun.`,
      );
    }
    toAppend[key] = runValue;
  }
  const appended = Object.keys(toAppend);
  if (appended.length > 0) appendRepoDotEnv(toAppend, provenance, filePath);
  return appended;
}
