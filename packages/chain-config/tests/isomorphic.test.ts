// The standing guard on this package's one critical invariant: src/ must run
// unchanged in BOTH a browser and Node.
//
// Neither way of breaking it fails a build. A Node builtin gets externalised
// into a stub by the bundler rather than rejected, and a DOM global type-checks
// because lib.dom is in this package's tsconfig for the URL type. So the check
// has to be explicit, and it lives here rather than in a lint config because
// `yarn test` is what CI already runs.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../src/", import.meta.url);

// Comments legitimately name the very globals this bans (explaining which
// consumer reads which environment), so they are stripped before scanning.
function sourceWithoutComments(fileName: string): string {
  return readFileSync(new URL(fileName, SRC_DIR), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** A global available in only one of the two runtimes, so banned from src/. */
interface ForbiddenGlobal {
  readonly description: string;
  readonly breaks: string;
  readonly pattern: RegExp;
}

const FORBIDDEN_GLOBALS: readonly ForbiddenGlobal[] = [
  { description: "a node: import", breaks: "the browser", pattern: /from\s*["']node:/ },
  { description: "process", breaks: "the browser", pattern: /\bprocess\s*[.[]/ },
  { description: "Buffer", breaks: "the browser", pattern: /\bBuffer\s*[.(]/ },
  { description: "__dirname", breaks: "the browser", pattern: /\b__dirname\b/ },
  { description: "require", breaks: "the browser", pattern: /\brequire\s*\(/ },
  { description: "import.meta.env", breaks: "Node", pattern: /\bimport\.meta\.env\b/ },
  { description: "document", breaks: "Node", pattern: /\bdocument\s*[.[]/ },
  { description: "window", breaks: "Node", pattern: /\bwindow\s*[.[]/ },
  { description: "localStorage", breaks: "Node", pattern: /\blocalStorage\b/ },
  { description: "navigator", breaks: "Node", pattern: /\bnavigator\s*[.[]/ },
];

describe("chain-config stays isomorphic", () => {
  const sourceFileNames = readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts"));

  it("has source files to check", () => {
    expect(sourceFileNames.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_GLOBALS)("no source file uses $description, which breaks $breaks", ({ pattern }) => {
    const offenders = sourceFileNames.filter((name) => pattern.test(sourceWithoutComments(name)));
    expect(offenders).toEqual([]);
  });

  // A runtime dependency is the likeliest way the guarantee dies, and unlike a
  // stray global it would not show up in the scan above.
  it("declares no runtime dependency", () => {
    const manifest: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(new URL("../package.json", SRC_DIR), "utf8"),
    );
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
