// The worker-side half of the setup/flow split: what every flow test FILE
// imports (via `@midnight-examples/test-harness/flow-hooks`) to join the
// pipeline. Counterpart of setup-pipeline.ts, and the only src module that
// imports `vitest` test APIs — it is deliberately NOT re-exported from
// index.ts, so nothing globalSetup loads can pull it in (vitest's
// worker-only APIs are unavailable in the main process).

import "./provided-context.ts";
import { beforeEach, inject } from "vitest";
import { testHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

const MINUTE = 60_000;

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
  beforeEach(async (ctx) => {
    const siblings = ctx.task.suite?.tasks ?? [];
    const index = siblings.indexOf(ctx.task);
    if (process.env.STEP_THROUGH && index > 0) {
      await waitForGo(index + 1, siblings.length, ctx.task.name);
    }
    testHeader(index + 1, siblings.length, ctx.task.name);
  }, 60 * MINUTE);
}
