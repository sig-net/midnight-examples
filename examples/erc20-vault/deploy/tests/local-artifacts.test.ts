import { createHash } from "node:crypto";

import type * as SharedLib from "@sig-net/midnight-examples-lib";
import { describe, expect, it, vi } from "vitest";

import { assertLocalRelease, verifyLocalArtifacts } from "../src/local-artifacts.ts";

const state = vi.hoisted(() => ({
  corrupt: false,
  missing: false,
  incompatibleSource: false,
  manifest: "",
}));
vi.mock("node:fs", () => ({
  readFileSync: (path: string): string | Buffer => {
    if (path.endsWith("contract-manifest.json")) return state.manifest;
    if (path.endsWith("erc20-vault.compact"))
      return Buffer.from(
        state.incompatibleSource && path.startsWith("/ui/") ? "different source" : "same source",
      );
    if (path.includes("/keys/")) {
      if (state.missing) throw new Error("missing key");
      return Buffer.from(state.corrupt ? "bad" : "key");
    }
    throw new Error(`Unexpected fixture read: ${path}`);
  },
}));
vi.mock("@sig-net/midnight-examples-lib", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedLib>()),
  REPO_ROOT: "/examples",
}));

const MANIFEST = JSON.stringify({
  "manifest-version": "1",
  "compiler-version": "0.33.0",
  "language-version": "0.25.0",
  "runtime-version": "0.18.0-rc.1",
  keys: {
    type: "directory",
    "startDeposit.prover": {
      type: "file",
      size: 3,
      hash: createHash("sha256").update("key").digest("hex"),
    },
  },
});

describe("deployment artefact integrity", () => {
  it.each([
    { corrupt: false, missing: false, incompatibleSource: false, fails: false },
    { corrupt: true, missing: false, incompatibleSource: false, fails: true },
    { corrupt: false, missing: true, incompatibleSource: false, fails: true },
    { corrupt: false, missing: false, incompatibleSource: true, fails: true },
  ])("validates source and every key: %j", (row) => {
    Object.assign(state, row, { manifest: MANIFEST });
    let failed = false;
    try {
      verifyLocalArtifacts("/ui");
    } catch {
      failed = true;
    }
    expect(failed).toBe(row.fails);
  });
  it("rejects an empty input set and restores the verified baseline", () => {
    Object.assign(state, {
      corrupt: false,
      missing: false,
      incompatibleSource: false,
      manifest: JSON.stringify({
        "manifest-version": "1",
        "compiler-version": "0.33.0",
        "language-version": "0.25.0",
        "runtime-version": "0.18.0-rc.1",
      }),
    });
    expect(() => {
      assertLocalRelease("/ui");
    }).toThrow();
    state.manifest = MANIFEST;
    expect(() => {
      verifyLocalArtifacts("/ui");
    }).not.toThrow();
  });
});
