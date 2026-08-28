// Repo-root location + minimal `.env` reader, shared by every entrypoint that
// must run with the operator's hand-maintained environment: the examples'
// deploy entrypoints and the e2e setup pipeline. Node's own loaders cannot be
// used here (vitest/node reject `--env-file` in NODE_OPTIONS), so each
// entrypoint loads the file itself and overlays `process.env` on top.
// Deliberately minimal: KEY=VALUE lines, #-comments, optional single/double
// quotes; no interpolation, no multiline.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (where the workspace's root scripts and `.env` live). */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Read the repo-root `.env` file into a plain map. Missing file yields an
 * empty map. Callers should overlay `process.env` on top so the real
 * environment always wins over the file.
 *
 * @returns The parsed KEY=VALUE pairs (empty values skipped).
 */
export function loadRepoDotEnv(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, ".env"), "utf8");
  } catch {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [, key, rawValue] =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line) ?? [];
    if (key === undefined || rawValue === undefined || line.trimStart().startsWith("#")) {
      continue;
    }
    const value = rawValue.replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "") {
      parsed[key] = value;
    }
  }
  return parsed;
}

/**
 * The environment an entrypoint runs against: the repo-root `.env` overlaid
 * with the real `process.env`, which wins. Every deploy entrypoint and the e2e
 * setup pipeline start from this, which is what keeps them reading ONE set of
 * variables. `process.env` itself is never mutated: the returned map is passed
 * explicitly to config readers, and the setup pipeline mutates it in place as
 * its accumulator (each value under its canonical env-var name, whose presence
 * doubles as that step's skip signal).
 *
 * @returns The merged environment map.
 */
export function buildBaseEnv(): NodeJS.ProcessEnv {
  return { ...loadRepoDotEnv(), ...process.env };
}
