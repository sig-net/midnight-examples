// The benchmark report generator: merges the static circuit metrics
// (scripts/benchmark-static.ts) with the dynamic proof-server records the
// e2e benchmark appends (tests/benchmark.test.ts via the Recorder) into one
// per-circuit markdown report. Dynamic columns use each circuit's most
// recent run, so partial reruns refresh their rows without invalidating the
// rest. Rows are never fabricated: circuits with no dynamic records simply
// show none.

import { existsSync, readFileSync } from "node:fs";

import { BenchmarkLeg, type BenchRecord, BenchRecordKind } from "./records.ts";
import type { CircuitStaticMetrics } from "./static-metrics.ts";

/**
 * Read all {@link BenchRecord}s from a JSONL file.
 *
 * @param filePath - The JSONL file the Recorder appends to.
 * @returns The records in file order; empty when the file does not exist.
 */
export function loadBenchRecords(filePath: string): BenchRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BenchRecord);
}

/** Summary statistics of one set of duration samples. */
export interface DurationStats {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Compute {@link DurationStats} over samples.
 *
 * @param values - The duration samples.
 * @returns The stats, or undefined when there are no samples.
 */
export function durationStats(values: readonly number[]): DurationStats | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (index: number): number => {
    const value = sorted.at(index);
    if (value === undefined) throw new Error(`no sample at index ${String(index)}`);
    return value;
  };
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2,
    min: at(0),
    max: at(sorted.length - 1),
  };
}

/**
 * The records of the most recent run that contains any record matching
 * `matches`. Runs compose: a rerun of one leg refreshes that leg only.
 *
 * @param records - All loaded records.
 * @param matches - Selector for the records of interest.
 * @returns The matching records of the latest such run.
 */
export function latestRunRecords(
  records: readonly BenchRecord[],
  matches: (record: BenchRecord) => boolean,
): BenchRecord[] {
  const mine = records.filter(matches);
  const lastRunId = [...new Set(mine.map((record) => record.runId))].sort().at(-1);
  return mine.filter((record) => record.runId === lastRunId);
}

const formatInt = (n: number): string => n.toLocaleString("en-US");
const formatMs = (ms: number | undefined): string =>
  ms === undefined ? "-" : `${(ms / 1000).toFixed(2)}s`;
const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");

/**
 * Render the merged static + dynamic benchmark report.
 *
 * @param statics - The static metrics rows (from scripts/benchmark-static.ts output).
 * @param records - All dynamic records (from {@link loadBenchRecords}).
 * @returns The report as markdown.
 */
export function renderBenchmarkReport(
  statics: readonly CircuitStaticMetrics[],
  records: readonly BenchRecord[],
): string {
  const sections: string[] = ["# erc20-vault benchmark report", ""];
  const runIds = [...new Set(records.map((record) => record.runId))].sort();
  sections.push(
    `Generated ${new Date().toISOString()} from ${String(runIds.length)} recorded run(s)` +
      (runIds.length > 0 ? ` (latest: \`${runIds.at(-1) ?? ""}\`).` : "."),
    "",
  );

  // Per-circuit table: static columns plus prove/check stats from the
  // latest run that proved that circuit. Warm proves (seq > 1) and the cold
  // first prove are reported separately: the cold one pays the proof
  // server's prover-key load.
  const circuitRows: string[][] = [];
  for (const staticRow of statics) {
    const proves = latestRunRecords(
      records,
      (record) =>
        record.kind === BenchRecordKind.Prove &&
        record.keyCircuit === staticRow.circuit &&
        record.error === undefined,
    );
    const checks = latestRunRecords(
      records,
      (record) =>
        record.kind === BenchRecordKind.Check &&
        record.keyCircuit === staticRow.circuit &&
        record.error === undefined,
    );
    const cold = proves.find((record) => record.seq === 1);
    const warmStats = durationStats(
      proves.filter((record) => record.seq !== 1).map((record) => record.ms),
    );
    const proofBytes = proves.find((record) => record.proofBytes !== undefined)?.proofBytes;
    circuitRows.push([
      staticRow.contract,
      `\`${staticRow.circuit}\``,
      String(staticRow.model.k),
      formatInt(staticRow.model.rows),
      formatInt(staticRow.model.tableRows),
      formatInt(staticRow.zkirInstructions),
      formatMs(cold?.ms),
      warmStats === undefined
        ? "-"
        : `${formatMs(warmStats.median)} (n=${String(warmStats.n)}, ${formatMs(warmStats.min)}..${formatMs(warmStats.max)})`,
      proofBytes === undefined ? "-" : `${formatInt(proofBytes)} B`,
      formatMs(durationStats(checks.map((record) => record.ms))?.median),
    ]);
  }
  sections.push(
    "## Per circuit: static cost model + proof-server round trips",
    "",
    "`prove (cold)` is the run's first prove of that circuit (includes the",
    "proof server's prover-key load); `prove (warm)` is the median of the",
    "rest. A call transaction proves every circuit in its call tree, so one",
    "vault request also proves the SignetSigner callee.",
    "",
    table(
      [
        "contract",
        "circuit",
        "k",
        "rows",
        "table_rows",
        "zkir instrs",
        "prove (cold)",
        "prove (warm, median)",
        "proof bytes",
        "check (median)",
      ],
      circuitRows,
    ),
    "",
  );

  // E2e leg wall clock: the whole-pipeline context numbers.
  const legRows: string[][] = [];
  for (const leg of Object.values(BenchmarkLeg)) {
    const mine = latestRunRecords(
      records,
      (record) => record.kind === BenchRecordKind.Leg && record.leg === leg,
    );
    const stats = durationStats(mine.map((record) => record.ms));
    if (stats === undefined) continue;
    legRows.push([`\`${leg}\``, formatMs(stats.median), String(stats.n)]);
  }
  sections.push("## E2e legs: wall clock (latest run per leg)", "");
  if (legRows.length > 0) {
    sections.push(table(["leg", "wall clock (median)", "n"], legRows), "");
  } else {
    sections.push(
      "No dynamic records yet: run the e2e benchmark (tests/benchmark.test.ts) against a live stack first.",
      "",
    );
  }

  return sections.join("\n");
}
