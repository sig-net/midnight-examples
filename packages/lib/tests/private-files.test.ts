import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { writePrivate } from "../src/private-files.ts";

it("replaces a permissive pending file with private complete content", () => {
  const directory = mkdtempSync(join(tmpdir(), "setup-private-file-"));
  const path = join(directory, "setup.env");
  try {
    writeFileSync(`${path}.pending`, "partial", { mode: 0o644 });
    expect(statSync(`${path}.pending`).mode & 0o777).toBe(0o644);
    writePrivate(path, "complete\n");
    expect(readFileSync(path, "utf8")).toBe("complete\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
