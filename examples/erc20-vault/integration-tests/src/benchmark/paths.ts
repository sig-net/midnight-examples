// Where benchmark outputs land: everything under this package's reports/
// directory, which the repo-root .gitignore and .prettierignore already cover
// (the `reports/` pattern matches at any depth), so generated output is never
// committed or formatted.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's generated-benchmark-output directory (gitignored). */
export const BENCHMARK_REPORTS_DIR = fileURLToPath(new URL("../../reports", import.meta.url));

/** JSONL sink for {@link file://./records.ts BenchRecord}s, appended across runs. */
export const PROOF_RECORDS_FILE = join(BENCHMARK_REPORTS_DIR, "raw", "proof-records.jsonl");

/** JSON output of the static circuit-metrics collector (scripts/benchmark-static.ts). */
export const STATIC_METRICS_FILE = join(BENCHMARK_REPORTS_DIR, "static-metrics.json");

/** Markdown twin of {@link STATIC_METRICS_FILE}, written by the same script. */
export const STATIC_METRICS_MARKDOWN_FILE = join(BENCHMARK_REPORTS_DIR, "static-metrics.md");

/** The merged static + dynamic report (scripts/benchmark-report.ts). */
export const BENCHMARK_REPORT_FILE = join(BENCHMARK_REPORTS_DIR, "benchmark-report.md");
