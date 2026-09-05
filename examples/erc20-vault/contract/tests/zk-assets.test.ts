// Offline unit tests of the zk-assets logic: which manifest entries a served
// tree holds, how a tree is verified against the manifest, and how a
// regenerated compile is judged compatible with the shipped one. In-memory
// manifests and an injected reader: no toolchain, no filesystem.

import { computeSha256Hex, parseZkArtifactManifest } from "@midnight-ntwrk/midnight-js/utils";
import { describe, expect, it } from "vitest";

import { hasProverKeys, isServedEntry, servedEntries } from "../src/zk-assets/layout.ts";
import { explainBuildIncompatibility, MANIFEST_PATH, verifyTree } from "../src/zk-assets/verify.ts";

const encoder = new TextEncoder();

/** The bytes of a fixture compile, keyed by manifest path (a manifest never lists itself). */
const FILES: Record<string, Uint8Array> = {
  "compiler/contract-info.json": encoder.encode('{"circuits":[]}'),
  "contract/index.js": encoder.encode("export const Contract = 1;"),
  "contract/index.js.map": encoder.encode('{"sources":["../../src/x.compact"]}'),
  "keys/startDeposit.prover": encoder.encode("prover bytes"),
  "keys/startDeposit.verifier": encoder.encode("verifier bytes"),
  "zkir/startDeposit.bzkir": encoder.encode("binary zkir"),
  "zkir/startDeposit.zkir": encoder.encode("text zkir"),
};

/**
 * A compactc-shaped manifest JSON over `files`, with the given toolchain versions.
 *
 * @param files - The tree's bytes by manifest path.
 * @param versions - The compiler, language and runtime version fields.
 * @returns The manifest JSON text.
 */
function manifestJson(
  files: Record<string, Uint8Array>,
  versions = { compiler: "0.33.0", language: "0.25.0", runtime: "0.18.0-rc.1" },
): string {
  const directories: Record<string, Record<string, unknown>> = {};
  for (const [relativePath, bytes] of Object.entries(files)) {
    const [dir, name] = relativePath.split("/");
    if (dir === undefined || name === undefined)
      throw new Error(`bad fixture path ${relativePath}`);
    directories[dir] ??= { type: "directory" };
    directories[dir][name] = { type: "file", size: bytes.length, hash: computeSha256Hex(bytes) };
  }
  return JSON.stringify({
    "manifest-version": "1",
    "compiler-version": versions.compiler,
    "language-version": versions.language,
    "runtime-version": versions.runtime,
    ...directories,
  });
}

const MANIFEST_JSON = manifestJson(FILES);
const MANIFEST_BYTES = encoder.encode(MANIFEST_JSON);
const MANIFEST = parseZkArtifactManifest(MANIFEST_JSON);

/** A served tree: the compile's served files plus the manifest file itself. */
const TREE: Record<string, Uint8Array> = { ...FILES, [MANIFEST_PATH]: MANIFEST_BYTES };

describe("isServedEntry / servedEntries", () => {
  it.each([
    ["keys/startDeposit.prover", true],
    ["keys/startDeposit.verifier", true],
    ["zkir/startDeposit.bzkir", true],
    ["zkir/startDeposit.zkir", false],
    ["compiler/contract-info.json", true],
    ["contract/index.js", false],
  ])("%s served: %s", (relativePath, served) => {
    expect(isServedEntry(relativePath)).toBe(served);
  });

  it("lists every served entry of the manifest, sorted, and nothing else", () => {
    expect(servedEntries(MANIFEST)).toEqual([
      "compiler/contract-info.json",
      "keys/startDeposit.prover",
      "keys/startDeposit.verifier",
      "zkir/startDeposit.bzkir",
    ]);
  });
});

describe("hasProverKeys", () => {
  it("is true for a full compile and false for a --skip-zk one", () => {
    expect(hasProverKeys(MANIFEST)).toBe(true);
    const skipZk = Object.fromEntries(
      Object.entries(FILES).filter(([relativePath]) => !relativePath.startsWith("keys/")),
    );
    expect(hasProverKeys(parseZkArtifactManifest(manifestJson(skipZk)))).toBe(false);
  });
});

describe("verifyTree", () => {
  interface Case {
    name: string;
    tree: Record<string, Uint8Array>;
    expected: { relativePath: string; reason: RegExp }[];
  }

  const CASES: Case[] = [
    { name: "a tree matching the manifest", tree: TREE, expected: [] },
    {
      name: "a tree without the manifest file itself",
      tree: FILES,
      expected: [{ relativePath: MANIFEST_PATH, reason: /missing/ }],
    },
    {
      name: "a tree carrying a different manifest",
      tree: { ...TREE, [MANIFEST_PATH]: encoder.encode("{}") },
      expected: [{ relativePath: MANIFEST_PATH, reason: /differs/ }],
    },
    {
      name: "a tree missing one served file",
      tree: Object.fromEntries(
        Object.entries(TREE).filter(([relativePath]) => relativePath !== "zkir/startDeposit.bzkir"),
      ),
      expected: [{ relativePath: "zkir/startDeposit.bzkir", reason: /missing/ }],
    },
    {
      name: "a tree with a key of the right size and wrong bytes",
      tree: { ...TREE, "keys/startDeposit.prover": encoder.encode("PROVER bytes") },
      expected: [{ relativePath: "keys/startDeposit.prover", reason: /hash|digest|sha/i }],
    },
    {
      name: "a tree with a truncated key",
      tree: { ...TREE, "keys/startDeposit.prover": encoder.encode("prover") },
      expected: [{ relativePath: "keys/startDeposit.prover", reason: /bytes|size|length/i }],
    },
    {
      name: "a tree whose unserved files differ",
      tree: { ...TREE, "contract/index.js": encoder.encode("something else") },
      expected: [],
    },
  ];

  it.each(CASES)("$name", async ({ tree, expected }) => {
    const mismatches = await verifyTree(MANIFEST, MANIFEST_BYTES, (relativePath) =>
      Promise.resolve(tree[relativePath]),
    );
    expect(mismatches.map((m) => m.relativePath)).toEqual(expected.map((e) => e.relativePath));
    for (const [index, { reason }] of expected.entries()) {
      expect(mismatches[index]?.reason).toMatch(reason);
    }
  });
});

describe("explainBuildIncompatibility", () => {
  it("accepts a regenerated compile whose only difference is the source map", () => {
    const regenerated = parseZkArtifactManifest(
      manifestJson({
        ...FILES,
        "contract/index.js.map": encoder.encode('{"sources":["x.compact"]}'),
      }),
    );
    expect(explainBuildIncompatibility(MANIFEST, regenerated)).toEqual([]);
  });

  it("names every toolchain version that differs", () => {
    const regenerated = parseZkArtifactManifest(
      manifestJson(FILES, { compiler: "0.34.0", language: "0.25.0", runtime: "0.19.0" }),
    );
    expect(explainBuildIncompatibility(MANIFEST, regenerated)).toEqual([
      "compiler-version: the package was built with 0.33.0, this compile used 0.34.0",
      "runtime-version: the package was built with 0.18.0-rc.1, this compile used 0.19.0",
    ]);
  });

  it("rejects a compile of a different circuit table", () => {
    const regenerated = parseZkArtifactManifest(
      manifestJson({ ...FILES, "compiler/contract-info.json": encoder.encode('{"circuits":[1]}') }),
    );
    expect(explainBuildIncompatibility(MANIFEST, regenerated)).toEqual([
      "compiler/contract-info.json differs: the compiled circuit table is not the shipped one",
    ]);
  });
});
