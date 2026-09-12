// Static (compile-time) circuit metrics, read off a contract's compiled
// managed/ output with no running stack:
//
//   - zkir/<circuit>.zkir: the JSON arithmetic-circuit IR (instruction
//     count, per-op histogram, input count).
//   - zkir/<circuit>.bzkir: the binary IR the toolchain's `zkir-v3
//     mock-compile` runs the Halo2 cost model over, yielding k / rows /
//     table_rows: the domain exponent k is the dominant driver of proving
//     cost, so it is the primary optimisation signal.
//   - keys/<circuit>.prover / .verifier: key byte sizes (a full
//     `compile:zk` must have run; the default compile is --skip-zk).
//
// compact-zkir-lint contributes the conditional-cost counters
// (constrain_bits, cond_select, guarded regions). Its own `k` field is a
// heuristic estimate that disagrees with the Halo2 cost model, so it is
// deliberately not surfaced: k comes from mock-compile only.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { analyzeFile, type ZkirV3 } from "compact-zkir-lint";

/**
 * Resolve the pinned toolchain's `zkir-v3` binary from the `compactc` symlink
 * in the compact launcher's bin directory, so the toolchain version pin stays
 * in its existing sites (README prerequisites, CI) and gains no new one here.
 *
 * @param env - Environment to read the `COMPACT_DIRECTORY` override from.
 * @returns Absolute path of the `zkir-v3` binary.
 * @throws {Error} If the launcher's compactc symlink or the zkir-v3 sibling is missing.
 */
export function resolveZkirV3Binary(env: NodeJS.ProcessEnv): string {
  const compactDirectory = env.COMPACT_DIRECTORY ?? join(homedir(), ".compact");
  const compactcLink = join(compactDirectory, "bin", "compactc");
  if (!existsSync(compactcLink)) {
    throw new Error(
      `${compactcLink} not found: install the pinned toolchain with ` +
        "`compact update <version in the README's Prerequisites>`",
    );
  }
  const zkirV3 = join(dirname(realpathSync(compactcLink)), "zkir-v3");
  if (!existsSync(zkirV3)) {
    throw new Error(`${zkirV3} not found beside the resolved compactc: reinstall the toolchain`);
  }
  return zkirV3;
}

/**
 * The Halo2 cost model of one circuit, parsed from the `CircuitModel { ... }`
 * line `zkir-v3 mock-compile -v` prints.
 */
export interface CircuitModel {
  /** Domain exponent: the circuit is laid out on 2^k rows. */
  readonly k: number;
  /** Gate rows used (excluding lookup table rows). */
  readonly rows: number;
  /** Fixed lookup-table rows (partly k-dependent: the pow2range table spans 2^(k-1) rows). */
  readonly tableRows: number;
  readonly nbUnusableRows: number;
  readonly maxDeg: number;
  readonly adviceColumns: number;
  readonly fixedColumns: number;
  readonly lookups: number;
  readonly permutations: number;
  readonly columnQueries: number;
  readonly pointSets: number;
  /** Predicted proof size in bytes. */
  readonly size: number;
}

// Keys of the CircuitModel line mapped to CircuitModel fields. Also the
// completeness check: every key must be present in the parsed line.
const CIRCUIT_MODEL_KEYS: readonly (readonly [string, keyof CircuitModel])[] = [
  ["k", "k"],
  ["rows", "rows"],
  ["table_rows", "tableRows"],
  ["nb_unusable_rows", "nbUnusableRows"],
  ["max_deg", "maxDeg"],
  ["advice_columns", "adviceColumns"],
  ["fixed_columns", "fixedColumns"],
  ["lookups", "lookups"],
  ["permutations", "permutations"],
  ["column_queries", "columnQueries"],
  ["point_sets", "pointSets"],
  ["size", "size"],
];

/**
 * Run `zkir-v3 mock-compile -v` on one binary IR file and parse the cost
 * model it reports. Mock compilation runs the full Halo2 layouter without
 * generating keys, so it takes seconds, not minutes.
 *
 * @param zkirV3Path - The `zkir-v3` binary (see {@link resolveZkirV3Binary}).
 * @param bzkirPath - The circuit's `.bzkir` file.
 * @returns The parsed cost model.
 * @throws {Error} If the process fails or its output carries no complete CircuitModel line.
 */
export function runMockCompile(zkirV3Path: string, bzkirPath: string): CircuitModel {
  const result = spawnSync(zkirV3Path, ["mock-compile", "-v", bzkirPath], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`zkir-v3 mock-compile failed for ${bzkirPath}: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `zkir-v3 mock-compile exited ${String(result.status)} for ${bzkirPath}:\n${result.stderr}`,
    );
  }
  return parseCircuitModel(`${result.stdout}\n${result.stderr}`, bzkirPath);
}

// SGR colour sequences (ESC [ ... m): zkir-v3 colours its log output even
// when piped, so the model line must be stripped before parsing. Built via
// fromCharCode so the pattern carries no literal control character.
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Parse the `CircuitModel { key: value, ... }` line out of mock-compile
 * output (which is ANSI-coloured even when piped).
 *
 * @param output - Combined stdout + stderr of the mock-compile run.
 * @param source - Label for error messages.
 * @returns The parsed cost model.
 * @throws {Error} If no CircuitModel line is present or a field is missing/non-numeric.
 */
export function parseCircuitModel(output: string, source: string): CircuitModel {
  const plain = output.replace(ANSI_SGR_PATTERN, "");
  const match = /CircuitModel \{([^}]*)\}/.exec(plain);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`no CircuitModel line in zkir-v3 output for ${source}`);
  }

  const fields = new Map<string, number>();
  for (const pair of body.split(",")) {
    const [key, value] = pair.split(":").map((part) => part.trim());
    if (key !== undefined && value !== undefined && /^\d+$/.test(value)) {
      fields.set(key, Number(value));
    }
  }

  const model: Partial<Record<keyof CircuitModel, number>> = {};
  for (const [key, field] of CIRCUIT_MODEL_KEYS) {
    const value = fields.get(key);
    if (value === undefined) {
      throw new Error(`CircuitModel line for ${source} is missing '${key}'`);
    }
    model[field] = value;
  }
  return model as CircuitModel;
}

/**
 * Conditional-cost counters for one circuit, from compact-zkir-lint's
 * analysis. Guarded regions and cond_selects are the compiler's workarounds
 * for conditionally executed code, a documented circuit-size cost.
 */
export interface CircuitLintCounters {
  readonly constrainBits: number;
  readonly condSelects: number;
  readonly guardedRegions: number;
  readonly maxGuardDepth: number;
  readonly asserts: number;
  /** Count of lint findings (0 on a clean circuit). */
  readonly findings: number;
}

/** Compile-time metrics for one provable circuit of one compiled contract. */
export interface CircuitStaticMetrics {
  /** The contract (managed dir label) the circuit belongs to. */
  readonly contract: string;
  readonly circuit: string;
  /** The Halo2 cost model (k, rows, table rows, columns...). */
  readonly model: CircuitModel;
  /** Total instruction count of the zkir program. */
  readonly zkirInstructions: number;
  /** Declared circuit input count. */
  readonly zkirInputs: number;
  /** Instructions per zkir op name, for attributing growth to constructs. */
  readonly opHistogram: Readonly<Record<string, number>>;
  /** Byte sizes of the compiled artifacts. */
  readonly zkirBytes: number;
  readonly bzkirBytes: number;
  readonly proverKeyBytes: number;
  readonly verifierKeyBytes: number;
  /** Conditional-cost counters from compact-zkir-lint. */
  readonly lint: CircuitLintCounters;
}

/**
 * Collect {@link CircuitStaticMetrics} for every provable circuit of one
 * compiled contract.
 *
 * @param managedPath - Absolute path of the contract's compiler output dir (holding zkir/, keys/).
 * @param contract - Label for the `contract` field of each row.
 * @param zkirV3Path - The `zkir-v3` binary (see {@link resolveZkirV3Binary}).
 * @returns One row per provable circuit, sorted by circuit name.
 * @throws {Error} If zkir/ or keys/ output is missing: run `yarn compile:erc20-vault:zk`
 *   first (the default compile is --skip-zk and generates no keys).
 */
export async function collectContractStaticMetrics(
  managedPath: string,
  contract: string,
  zkirV3Path: string,
): Promise<CircuitStaticMetrics[]> {
  const zkirDir = join(managedPath, "zkir");
  const keysDir = join(managedPath, "keys");
  if (!existsSync(zkirDir) || !existsSync(keysDir)) {
    throw new Error(
      `${managedPath} has no zkir/ + keys/ output: run \`yarn compile:erc20-vault:zk\` first`,
    );
  }

  const rows: CircuitStaticMetrics[] = [];
  for (const file of readdirSync(zkirDir)) {
    if (!file.endsWith(".zkir")) continue;
    const circuit = file.slice(0, -".zkir".length);
    const zkirPath = join(zkirDir, file);
    const zkir = JSON.parse(readFileSync(zkirPath, "utf8")) as ZkirV3;

    const opHistogram: Record<string, number> = {};
    for (const instruction of zkir.instructions) {
      opHistogram[instruction.op] = (opHistogram[instruction.op] ?? 0) + 1;
    }

    const lintReport = await analyzeFile(zkirPath);
    rows.push({
      contract,
      circuit,
      model: runMockCompile(zkirV3Path, join(zkirDir, `${circuit}.bzkir`)),
      zkirInstructions: zkir.instructions.length,
      zkirInputs: zkir.inputs.length,
      opHistogram,
      zkirBytes: statSync(zkirPath).size,
      bzkirBytes: statSync(join(zkirDir, `${circuit}.bzkir`)).size,
      proverKeyBytes: statSync(join(keysDir, `${circuit}.prover`)).size,
      verifierKeyBytes: statSync(join(keysDir, `${circuit}.verifier`)).size,
      lint: {
        constrainBits: lintReport.stats.constrainBitsCount,
        condSelects: lintReport.stats.condSelectCount,
        guardedRegions: lintReport.stats.guardedRegions,
        maxGuardDepth: lintReport.stats.maxGuardDepth,
        asserts: lintReport.stats.assertCount,
        findings: lintReport.findings.length,
      },
    });
  }
  return rows.sort((a, b) => a.circuit.localeCompare(b.circuit));
}

const formatInt = (n: number): string => n.toLocaleString("en-US");

/**
 * Render the per-circuit static-metrics markdown table.
 *
 * @param rows - The collected metrics.
 * @returns A markdown table, one row per circuit.
 */
export function renderStaticMetricsMarkdown(rows: readonly CircuitStaticMetrics[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  const headers = [
    "contract",
    "circuit",
    "k",
    "rows",
    "table_rows",
    "zkir instrs",
    "prover key",
    "verifier key",
    "constrain_bits",
    "cond_select",
    "guarded",
    "lint findings",
  ];
  return [
    line(headers),
    line(headers.map(() => "---")),
    ...rows.map((row) =>
      line([
        row.contract,
        `\`${row.circuit}\``,
        String(row.model.k),
        formatInt(row.model.rows),
        formatInt(row.model.tableRows),
        formatInt(row.zkirInstructions),
        `${formatInt(row.proverKeyBytes)} B`,
        `${formatInt(row.verifierKeyBytes)} B`,
        String(row.lint.constrainBits),
        String(row.lint.condSelects),
        String(row.lint.guardedRegions),
        String(row.lint.findings),
      ]),
    ),
  ].join("\n");
}
