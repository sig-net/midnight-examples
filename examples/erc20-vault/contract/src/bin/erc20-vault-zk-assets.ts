#!/usr/bin/env node
// `erc20-vault-zk-assets <out-dir> [--vault-only | --signet-only] [--force]`:
// regenerate the vault's zk artefacts with the pinned compact toolchain,
// verify them against the manifest this package ships, and lay them out with
// the signet callee's under <out-dir> in the layout a fetch-based zk config
// provider reads. The logic is src/zk-assets/, this file is the argv shell.
// POSIX paths only.

import { parseArgs } from "node:util";

import { CompileFailedError, ToolchainError } from "../zk-assets/compact-toolchain.ts";
import { runZkAssets, VerificationFailedError } from "../zk-assets/run.ts";

/** Process exit codes, one per failure class. */
enum ExitCode {
  Ok = 0,
  Usage = 1,
  Toolchain = 2,
  CompileFailed = 3,
  VerificationFailed = 4,
}

const USAGE =
  "usage: erc20-vault-zk-assets <out-dir> [--vault-only | --signet-only] [--force]\n" +
  "  lays out keys/, zkir/, compiler/ (the vault) and signet/{keys,zkir,compiler} under <out-dir>";

function parse(): { outDir: string; vault: boolean; signet: boolean; force: boolean } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "vault-only": { type: "boolean" },
      "signet-only": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(ExitCode.Ok);
  }
  const outDir = positionals.at(0);
  if (outDir === undefined || positionals.length !== 1) throw new Error(USAGE);
  if (values["vault-only"] && values["signet-only"]) {
    throw new Error(`--vault-only and --signet-only exclude each other\n${USAGE}`);
  }
  return {
    outDir,
    vault: !values["signet-only"],
    signet: !values["vault-only"],
    force: values.force ?? false,
  };
}

function fail(code: ExitCode, error: Error): never {
  console.error(`erc20-vault-zk-assets: ${error.message}`);
  process.exit(code);
}

let parsed: ReturnType<typeof parse>;
try {
  parsed = parse();
} catch (error) {
  fail(ExitCode.Usage, error instanceof Error ? error : new Error(String(error)));
}

try {
  const result = await runZkAssets({
    outDir: parsed.outDir,
    trees: { vault: parsed.vault, signet: parsed.signet },
    force: parsed.force,
    env: process.env,
    log: (line) => {
      console.log(line);
    },
  });
  console.log(`laid out under ${parsed.outDir}`);
  if (result.vaultManifestSha256 !== undefined) {
    console.log(`  vault  compiler/contract-manifest.json sha256 = ${result.vaultManifestSha256}`);
  }
  if (result.signetManifestSha256 !== undefined) {
    console.log(`  signet compiler/contract-manifest.json sha256 = ${result.signetManifestSha256}`);
  }
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (failure instanceof ToolchainError) fail(ExitCode.Toolchain, failure);
  if (failure instanceof CompileFailedError) fail(ExitCode.CompileFailed, failure);
  if (failure instanceof VerificationFailedError) fail(ExitCode.VerificationFailed, failure);
  throw failure;
}
