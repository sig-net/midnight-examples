// The main-process half of the setup/flow split: `runSetupSteps` runs an
// example's setup pipeline over an env accumulator, and `runSetupPipeline`
// runs it ONCE (in vitest's main process, via the example's globalSetup
// file) before ANY test file — including single-file selections — then hands
// the populated accumulator to the flow-test workers via project.provide. A
// throw there aborts the whole run before any test starts. Without
// RUN_INTEGRATION_TESTS it is a no-op so plain `yarn test` stays offline (the
// flow suites then skip via describe.skipIf and see an empty injected env).
// The example's local setup entrypoint runs `runSetupSteps` directly, outside
// vitest. No `vitest` imports here: worker-only test APIs are unavailable in
// the main process, and the worker-side half is flow-hooks.ts.

import "./provided-context.ts";

import { getMidnightNodeConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";
import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import type { TestProject } from "vitest/node";

import { testHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

/**
 * One named setup step: the name is what the operator greps for and what
 * STEP_THROUGH prompts show; the function mutates the shared env accumulator
 * (presence of a step's canonical env var doubles as its skip signal) and
 * takes the pipeline's wallet registry, one started facade per role wallet
 * for the whole pipeline.
 */
export type SetupStep = readonly [
  name: string,
  run: (env: NodeJS.ProcessEnv, wallets: WalletRegistry) => void | Promise<void>,
];

/**
 * Run an example's setup steps in order against `env`, the accumulator every
 * step reads from and writes its canonical env var into, and return it. One
 * {@link WalletRegistry} serves the whole run (the funding step syncs each
 * role wallet once, the deploy steps reuse the same facades) and closes
 * whatever the outcome. `STEP_THROUGH` pauses before each step after the
 * first, exactly as the flow files pause before each test.
 *
 * @param env - The accumulator, normally lib's `buildBaseEnv()` (repo-root `.env`
 *   overlaid with the real environment). Mutated in place.
 * @param steps - The ordered setup steps to run.
 * @returns `env`, populated by every step.
 * @throws {Error} Whatever the first failing step throws.
 */
export async function runSetupSteps(
  env: NodeJS.ProcessEnv,
  steps: readonly SetupStep[],
): Promise<NodeJS.ProcessEnv> {
  const wallets = new WalletRegistry(getMidnightNodeConfig(env));
  try {
    for (const [index, [name, run]] of steps.entries()) {
      if (process.env.STEP_THROUGH && index > 0) {
        await waitForGo(index + 1, steps.length, name);
      }
      testHeader(index + 1, steps.length, name);
      await run(env, wallets);
    }
  } finally {
    await wallets.close();
  }
  return env;
}

/**
 * Run an example's setup pipeline: build the base env (repo-root `.env`
 * overlaid with the real environment), run every step in order against it
 * via {@link runSetupSteps}, and provide the accumulated result to the test
 * workers as `e2eEnv` (read back via {@link file://./flow-hooks.ts injectE2eEnv}).
 * No-op when `RUN_INTEGRATION_TESTS` is unset. An example's vitest
 * `globalSetup` file is a thin wrapper: compose the {@link SetupStep} list
 * (generic steps from this package + the example's own) and export
 * `(project) => runSetupPipeline(project, STEPS)` as `setup`.
 *
 * @param project - The vitest project handed to globalSetup.
 * @param steps - The ordered setup steps to run.
 * @throws {Error} Whatever the first failing step throws (aborting the whole run).
 */
export async function runSetupPipeline(
  project: TestProject,
  steps: readonly SetupStep[],
): Promise<void> {
  if (!process.env.RUN_INTEGRATION_TESTS) return;

  const env = await runSetupSteps(buildBaseEnv(), steps);

  // Hand the accumulator to the flow-test workers. provide() requires
  // structured-cloneable values, so keep only the string entries (which is
  // everything a ProcessEnv legitimately holds anyway).
  project.provide(
    "e2eEnv",
    Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );
}
