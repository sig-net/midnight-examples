// Offline unit tests for the .env append-only writer — no stack, no env
// gate. The append-only guarantee (existing content survives byte-for-byte)
// is what lets the setup pipeline write to an operator's hand-edited .env.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendRepoDotEnv, persistToDotEnv } from "../src/env-file.ts";

const scratchEnvFile = (): string => join(mkdtempSync(join(tmpdir(), "env-file-test-")), ".env");

describe("appendRepoDotEnv", () => {
  it("appends a provenance-commented block, preserving existing content byte-for-byte", () => {
    const file = scratchEnvFile();
    const existing = "# operator notes stay untouched\nKEEP_ME=1\n\n  WEIRD_SPACING = kept \n";
    writeFileSync(file, existing, "utf8");

    appendRepoDotEnv(
      { MPC_ROOT_KEY: "0xabc", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "0200aa" },
      "test provenance",
      file,
    );

    const written = readFileSync(file, "utf8");
    expect(written.startsWith(existing)).toBe(true);
    expect(written.slice(existing.length)).toBe(
      "\n# test provenance\nMPC_ROOT_KEY=0xabc\nMIDNIGHT_SIGNET_CONTRACT_ADDRESS=0200aa\n",
    );
  });

  it("creates the file when missing", () => {
    const file = scratchEnvFile();

    appendRepoDotEnv({ MPC_ROOT_KEY: "0xabc" }, "test provenance", file);

    expect(readFileSync(file, "utf8")).toBe("\n# test provenance\nMPC_ROOT_KEY=0xabc\n");
  });
});

describe("persistToDotEnv", () => {
  const RUN_ENV: NodeJS.ProcessEnv = { MPC_ROOT_KEY: "0xabc", EVM_CHAIN_ID: "11155111" };
  const KEYS = ["MPC_ROOT_KEY", "EVM_CHAIN_ID", "EVM_VAULT_ADDRESS"] as const;

  const cases: {
    name: string;
    fileBefore: string;
    appended: string[];
    fileAfterContains: string[];
  }[] = [
    {
      name: "appends every key the file lacks, skipping keys absent from the run",
      fileBefore: "SEPOLIA_FORK_RPC_URL=https://rpc\n",
      appended: ["MPC_ROOT_KEY", "EVM_CHAIN_ID"],
      fileAfterContains: ["MPC_ROOT_KEY=0xabc", "EVM_CHAIN_ID=11155111"],
    },
    {
      name: "appends nothing when the file already holds the run's values",
      fileBefore: "MPC_ROOT_KEY=0xabc\nEVM_CHAIN_ID=11155111\n",
      appended: [],
      fileAfterContains: [],
    },
    {
      name: "appends only the keys the file lacks",
      fileBefore: "MPC_ROOT_KEY=0xabc\n",
      appended: ["EVM_CHAIN_ID"],
      fileAfterContains: ["EVM_CHAIN_ID=11155111"],
    },
  ];

  it.each(cases)("$name", ({ fileBefore, appended, fileAfterContains }) => {
    const file = scratchEnvFile();
    writeFileSync(file, fileBefore, "utf8");

    expect(persistToDotEnv(RUN_ENV, KEYS, "test provenance", file)).toEqual(appended);

    const written = readFileSync(file, "utf8");
    expect(written.startsWith(fileBefore)).toBe(true);
    for (const line of fileAfterContains) expect(written).toContain(line);
    expect(written.includes("# test provenance")).toBe(appended.length > 0);
  });

  it("creates the file when missing", () => {
    const file = scratchEnvFile();

    expect(persistToDotEnv(RUN_ENV, KEYS, "test provenance", file)).toEqual([
      "MPC_ROOT_KEY",
      "EVM_CHAIN_ID",
    ]);

    expect(readFileSync(file, "utf8")).toBe(
      "\n# test provenance\nMPC_ROOT_KEY=0xabc\nEVM_CHAIN_ID=11155111\n",
    );
  });

  it("refuses a key the file holds with a different value, writing nothing", () => {
    const file = scratchEnvFile();
    const existing = "MPC_ROOT_KEY=0xother\n";
    writeFileSync(file, existing, "utf8");

    expect(() => persistToDotEnv(RUN_ENV, KEYS, "test provenance", file)).toThrow(
      "MPC_ROOT_KEY conflicts",
    );
    expect(readFileSync(file, "utf8")).toBe(existing);
  });
});
