// Repo-root location + minimal `.env` reader, shared by every entrypoint that
// must run with the operator's hand-maintained environment: the examples'
// deploy entrypoints and the e2e setup pipeline. Node's own loaders cannot be
// used here (vitest/node reject `--env-file` in NODE_OPTIONS), so each
// entrypoint loads the file itself and overlays `process.env` on top.
// Deliberately minimal: KEY=VALUE lines, `#` comment lines, optional single or
// double quotes, and docker compose's inline-comment rule (see
// {@link parseDotEnv}), with no interpolation and no multiline. Compose reads the same
// file for the fakenet container, so a value must parse identically here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (where the workspace's root scripts and `.env` live). */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The value of one `KEY=<raw>` line, by docker compose's rules: a quoted
 * value is the text inside the quotes, whatever follows the closing quote
 * included a `#` comment, and an unquoted value is trimmed and ends at the first
 * `#` preceded by whitespace, while a `#` with no whitespace before it is
 * part of the value.
 *
 * @param raw - Everything after the `=`.
 * @returns The value as compose would hand it to a container.
 */
function parseDotEnvValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(trimmed)?.[2];
  if (quoted !== undefined) return quoted;
  // A single left-to-right scan for the first `#` preceded by whitespace: the
  // equivalent `\s+#` regex backtracks over every run of spaces on a line
  // without a comment, which is quadratic in the line's length.
  for (let index = 1; index < trimmed.length; index++) {
    if (trimmed[index] === "#" && /\s/.test(trimmed.charAt(index - 1))) {
      return trimmed.slice(0, index).trimEnd();
    }
  }
  return trimmed;
}

/**
 * Parse `.env` file text into a plain map: `KEY=value` lines with an optional
 * `export ` prefix, `#` comment lines skipped, values read by
 * {@link parseDotEnvValue}. A key's last occurrence wins, and an empty value
 * leaves the key out.
 *
 * @param text - The file's contents.
 * @returns The parsed KEY=VALUE pairs (empty values skipped).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const [, key, raw] = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line) ?? [];
    if (key === undefined || raw === undefined) continue;
    const value = parseDotEnvValue(raw);
    if (value !== "") {
      parsed[key] = value;
    }
  }
  return parsed;
}

/**
 * Read the repo-root `.env` file into a plain map with {@link parseDotEnv}.
 * Missing file yields an empty map. Callers should overlay `process.env` on
 * top so the real environment always wins over the file.
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
  return parseDotEnv(text);
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
