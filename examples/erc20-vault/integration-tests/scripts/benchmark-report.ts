// Merge reports/static-metrics.json (scripts/benchmark-static.ts) with the
// proof-server records the e2e benchmark appends
// (reports/raw/proof-records.jsonl) into reports/benchmark-report.md. Run:
// `yarn benchmark:report:erc20-vault` (repo root) or `yarn benchmark:report`
// (this package). Works without dynamic records: the report then carries the
// static columns only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  BENCHMARK_REPORT_FILE,
  PROOF_RECORDS_FILE,
  STATIC_METRICS_FILE,
} from "../src/benchmark/paths.ts";
import { loadBenchRecords, renderBenchmarkReport } from "../src/benchmark/report.ts";
import type { CircuitStaticMetrics } from "../src/benchmark/static-metrics.ts";

if (!existsSync(STATIC_METRICS_FILE)) {
  throw new Error(`${STATIC_METRICS_FILE} not found: run \`yarn benchmark:static\` first`);
}

const staticMetrics = JSON.parse(readFileSync(STATIC_METRICS_FILE, "utf8")) as {
  collectedAt: string;
  rows: CircuitStaticMetrics[];
};
const records = loadBenchRecords(PROOF_RECORDS_FILE);

const report = renderBenchmarkReport(staticMetrics.rows, records);
writeFileSync(BENCHMARK_REPORT_FILE, `${report}\n`);

console.log(report);
console.log(`\nwrote ${BENCHMARK_REPORT_FILE}`);
