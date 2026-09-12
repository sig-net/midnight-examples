import { closeSync, fchmodSync, openSync, renameSync, writeFileSync } from "node:fs";

/**
 * Replace a private generated file without exposing a partial configuration.
 *
 * @param path - Destination file.
 * @param text - Complete private file content.
 */
export function writePrivate(path: string, text: string): void {
  const temporary = `${path}.pending`;
  const file = openSync(temporary, "w", 0o600);
  try {
    fchmodSync(file, 0o600);
    writeFileSync(file, text);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
}
