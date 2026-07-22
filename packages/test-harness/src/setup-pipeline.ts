// The main-process half of the setup/flow split: runs an example's setup
// pipeline ONCE (in vitest's main process, via the example's globalSetup
// file) before ANY test file — including single-file selections — then hands
// the populated env accumulator to the flow-test workers via
// project.provide. A throw here aborts the whole run before any test starts.
// Without RUN_INTEGRATION_TESTS this is a no-op so plain `yarn test` stays
// offline (the flow suites then skip via describe.skipIf and see an empty
// injected env). No `vitest` imports here — worker-only test APIs are
// unavailable in the main process; the worker-side half is flow-hooks.ts.

import type { TestProject } from "vitest/node";
import "./provided-context.ts";
import { buildBaseEnv } from "./e2e-env.ts";
import { testHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

/**
 * One named setup step: the name is what the operator greps for and what
 * STEP_THROUGH prompts show; the function mutates the shared env accumulator
 * (presence of a step's canonical env var doubles as its skip signal).
 */
export type SetupStep = readonly [name: string, run: (env: NodeJS.ProcessEnv) => void | Promise<void>];

/**
 * Run an example's setup pipeline: build the base env (repo-root `.env`
 * overlaid with the real environment), run every step in order against it,
 * and provide the accumulated result to the test workers as `e2eEnv` (read
 * back via {@link file://./flow-hooks.ts injectE2eEnv}). No-op when
 * `RUN_INTEGRATION_TESTS` is unset. An example's vitest `globalSetup` file
 * is a thin wrapper: compose the {@link SetupStep} list (generic steps from
 * this package + the example's own) and export
 * `(project) => runSetupPipeline(project, STEPS)` as `setup`.
 *
 * @param project - The vitest project handed to globalSetup.
 * @param steps - The ordered setup steps to run.
 * @throws Whatever the first failing step throws (aborting the whole run).
 */
export async function runSetupPipeline(project: TestProject, steps: readonly SetupStep[]): Promise<void> {
  if (!process.env.RUN_INTEGRATION_TESTS) return;

  const env = buildBaseEnv();
  for (const [index, [name, run]] of steps.entries()) {
    // Step-through mode pauses before each step after the first, exactly as
    // the flow files pause before each test (globalSetup runs in the main
    // process, where /dev/tty is just as reachable as in a worker).
    if (process.env.STEP_THROUGH && index > 0) {
      await waitForGo(index + 1, steps.length, name);
    }
    testHeader(index + 1, steps.length, name);
    await run(env);
  }

  // Hand the accumulator to the flow-test workers. provide() requires
  // structured-cloneable values, so keep only the string entries (which is
  // everything a ProcessEnv legitimately holds anyway).
  project.provide(
    "e2eEnv",
    Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  );
}
