// Append-only writer for the repo-root `.env`, used by the setup steps that
// hand values to docker compose. Append-only BY DESIGN: the file is
// hand-edited by operators, and an append can never corrupt or reorder what
// they wrote. Reading is lib's `loadRepoDotEnv`, which every entrypoint (not
// just the suite) starts from.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "@sig-net/midnight-examples-lib";

/**
 * Append `KEY=value` lines to the repo-root `.env` under a one-line `#`
 * provenance comment, creating the file when missing. STRICTLY append-only:
 * existing lines are never read, reordered, or rewritten, so this call
 * cannot corrupt a hand-edited file. Presence and conflict checks are the
 * CALLER's job (via lib's `loadRepoDotEnv`) — never append a key the file
 * already holds: duplicate-key precedence differs between consumers (that
 * reader takes the last occurrence; docker compose applies its own rule), so
 * a duplicate is a latent inconsistency, not an override.
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
