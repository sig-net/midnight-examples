// The worker-side half of the setup/flow split: what every flow test FILE
// imports (via `@midnight-examples/test-harness/flow-hooks`) to join the
// pipeline. Counterpart of setup-pipeline.ts, and the only src module that
// imports `vitest` test APIs — it is deliberately NOT re-exported from
// index.ts, so nothing globalSetup loads can pull it in (vitest's
// worker-only APIs are unavailable in the main process).

import "./provided-context.ts";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeEach, inject } from "vitest";

import { testHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

const MINUTE = 60_000;
const execFileAsync = promisify(execFile);

// The local proof server's container name (docker-compose.yaml), the target of the between-file
// recycle.
const PROOF_SERVER_CONTAINER = "midnight-proof-server";

/**
 * Poll `url` until it answers (any HTTP response) or the deadline passes.
 *
 * @param url - The proof server URL to probe.
 * @param timeoutMs - How long to keep polling before giving up.
 */
async function waitForProofServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`proof server did not become reachable at ${url} after a restart`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Recycle the LOCAL proof server after each flow file. Heavy proofs accumulate memory across a
 * long sequential run (fileParallelism is off), and a single never-restarted server OOMs late in
 * the suite (ECONNREFUSED on the next prove). Restarting between files reclaims it, so each file
 * starts against a fresh server. Skipped when SKIP_PROOF_SERVER_RESTART is set, the proof server
 * is not local (a user's own / a remote one), or docker is unavailable.
 */
function installProofServerRecycle(): void {
  afterAll(async () => {
    if (process.env.SKIP_PROOF_SERVER_RESTART) return;
    const url = process.env.MIDNIGHT_PROOF_SERVER_URL ?? "http://127.0.0.1:6300";
    if (!/127\.0\.0\.1|localhost/.test(url)) return;
    try {
      await execFileAsync("docker", ["restart", PROOF_SERVER_CONTAINER]);
    } catch (error) {
      console.warn(`proof-server recycle skipped (docker unavailable?): ${String(error)}`);
      return;
    }
    await waitForProofServer(url, 3 * MINUTE);
  }, 5 * MINUTE);
}

/**
 * The env accumulator as populated by the setup pipeline (repo-root `.env`
 * overlaid with the real environment, plus every setup-derived pipeline
 * value). Returns an empty map when setup didn't run
 * (`RUN_INTEGRATION_TESTS` unset): `describe.skipIf` suites still evaluate
 * their module top level, and `inject` returns undefined when nothing was
 * provided.
 *
 * @returns A fresh copy of the provided env map (empty when setup didn't run).
 */
export function injectE2eEnv(): NodeJS.ProcessEnv {
  return { ...(inject("e2eEnv") ?? {}) };
}

/**
 * The shared per-flow-file hooks:
 * - Print a header before each test.
 * - Check for step-through mode to pause between each test (the setup steps
 *   pause on their own, in the setup pipeline).
 */
export function installFlowHooks(): void {
  installProofServerRecycle();
  beforeEach(async (ctx) => {
    const siblings = ctx.task.suite?.tasks ?? [];
    const index = siblings.indexOf(ctx.task);
    if (process.env.STEP_THROUGH && index > 0) {
      await waitForGo(index + 1, siblings.length, ctx.task.name);
    }
    testHeader(index + 1, siblings.length, ctx.task.name);
  }, 60 * MINUTE);
}
