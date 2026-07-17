// The env accumulator shared by the setup pipeline and the flow test files.
// This module MUST stay free of `vitest` imports: it is loaded by globalSetup
// in vitest's main process, where the worker-only test APIs are unavailable.
// The worker-side half (inject + hooks) lives in flow-hooks.ts.

import { loadRepoDotEnv } from "./env-file.ts";

/**
 * Environment accumulator: seeded from the repo-root `.env` file overlaid
 * with the real environment (which wins), then populated by the setup steps.
 * Each pipeline value lives under its canonical env-var name — presence
 * doubles as the step's skip signal, and the final printout is exactly the
 * example's pipeline keys. `process.env` itself is never mutated; the
 * accumulator is passed explicitly to config readers and subprocesses, and
 * handed to the test workers via vitest's provide/inject.
 *
 * @returns The merged env map the setup steps mutate in place.
 */
export function buildBaseEnv(): NodeJS.ProcessEnv {
  return { ...loadRepoDotEnv(), ...process.env };
}

/**
 * Assert a prior setup step populated `name`, failing with a pointed message.
 *
 * @param env - The suite's env accumulator.
 * @param name - The env-var name a prior step (or the operator's `.env`) must have set.
 * @returns The non-empty value.
 * @throws If the variable is unset or empty.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set — did the step that derives it run (or is it missing from your .env)?`);
  }
  return value;
}
