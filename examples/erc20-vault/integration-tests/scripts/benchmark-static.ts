// Collect the static circuit metrics of the vault and its signet callee
// (k / rows / table_rows from the Halo2 cost model, zkir instruction counts,
// key sizes, lint counters) and write reports/static-metrics.{json,md}.
// Needs compiled zk output (`yarn compile:erc20-vault:zk`) and no running
// stack. Run: `yarn benchmark:static:erc20-vault` (repo root) or
// `yarn benchmark:static` (this package).
//
// The optimisation inner loop: edit the contract, `yarn
// compile:erc20-vault:zk`, rerun this, compare k/rows/table_rows against the
// previous output. A k drop halves the proving domain; that is the signal
// worth chasing.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  SIGNET_SIGNER_MANAGED_PATH,
  VAULT_MANAGED_PATH,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import { STATIC_METRICS_FILE, STATIC_METRICS_MARKDOWN_FILE } from "../src/benchmark/paths.ts";
import {
  type CircuitStaticMetrics,
  collectContractStaticMetrics,
  renderStaticMetricsMarkdown,
  resolveZkirV3Binary,
} from "../src/benchmark/static-metrics.ts";

const zkirV3 = resolveZkirV3Binary(process.env);

const rows: CircuitStaticMetrics[] = [
  ...(await collectContractStaticMetrics(VAULT_MANAGED_PATH, "erc20-vault", zkirV3)),
  ...(await collectContractStaticMetrics(SIGNET_SIGNER_MANAGED_PATH, "SignetSigner", zkirV3)),
];

const markdown = renderStaticMetricsMarkdown(rows);
mkdirSync(dirname(STATIC_METRICS_FILE), { recursive: true });
writeFileSync(
  STATIC_METRICS_FILE,
  `${JSON.stringify({ collectedAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
writeFileSync(STATIC_METRICS_MARKDOWN_FILE, `${markdown}\n`);

console.log(markdown);
console.log(`\nwrote ${STATIC_METRICS_FILE}`);
console.log(`wrote ${STATIC_METRICS_MARKDOWN_FILE}`);
