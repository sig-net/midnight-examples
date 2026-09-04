// The worker-side half of the setup/flow split: what every flow test FILE
// imports (via `@sig-net/midnight-examples-test-harness/flow-hooks`) to join the
// pipeline. Counterpart of setup-pipeline.ts, and the only src module that
// imports `vitest` test APIs — it is deliberately NOT re-exported from
// index.ts, so nothing globalSetup loads can pull it in (vitest's
// worker-only APIs are unavailable in the main process).

import "./provided-context.ts";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getMidnightNodeConfig } from "@sig-net/midnight-examples-lib";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";

import { testHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

const MINUTE = 60_000;
const execFileAsync = promisify(execFile);

// The local proof server's container name (docker-compose.yaml), the target of the between-file
// recycle.
const PROOF_SERVER_CONTAINER = "midnight-proof-server";

/**
 * Whether the proof server answers at all. Any HTTP response counts: the server binds its port
 * only once it can serve, so a reply is the readiness signal.
 *
 * @param url - The proof server URL to probe.
 * @returns True when the server replied, false otherwise.
 */
async function proofServerAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The proof server container's state, as one line. `docker ps` reports a container that died and
 * came back as merely "Up", which hides the death; `OOMKilled`, `ExitCode` and `RestartCount` do
 * not. Returns a marker string rather than throwing, so it is safe inside an error path.
 *
 * @returns One line of container state, or a marker when docker cannot be reached.
 */
async function proofServerContainerState(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      PROOF_SERVER_CONTAINER,
      "--format",
      "running={{.State.Running}} oomKilled={{.State.OOMKilled}} exitCode={{.State.ExitCode}} restarts={{.RestartCount}} startedAt={{.State.StartedAt}}",
    ]);
    return stdout.trim();
  } catch (error) {
    return `state unavailable (${String(error)})`;
  }
}

/**
 * Poll `url` until it answers or the deadline passes. Reports the container's state on timeout,
 * so a failure says whether the server is missing, dead or merely slow.
 *
 * @param url - The proof server URL to probe.
 * @param timeoutMs - How long to keep polling before giving up.
 */
async function waitForProofServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await proofServerAnswers(url)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `proof server did not answer at ${url} after a restart; container: ${await proofServerContainerState()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * The local proof server URL, or null when the recycle does not apply: `SKIP_PROOF_SERVER_RESTART`
 * is set, or the configured server is not local (a user's own, or a remote one).
 *
 * Reads everything from the injected e2e env accumulator, the same env source the flows use:
 * repo-root `.env` values reach the workers ONLY through the accumulator (nothing loads `.env`
 * into `process.env`), so a bare `process.env` read here would miss them and diverge from the
 * suite's own config. Resolving the URL through {@link getMidnightNodeConfig} matters too:
 * `MIDNIGHT_PROOF_SERVER_URL` is how the FAKENET container finds the proof server, and
 * docker-compose sets it to `http://proof-server:6300`, a name that resolves only inside the
 * compose network. The test process wants `MIDNIGHT_NODE_PROOF_SERVER_URL`, which this resolves.
 *
 * @param env - The injected e2e env accumulator (see {@link injectE2eEnv}).
 * @returns The local proof server URL, or null when the recycle does not apply.
 */
function localProofServerUrl(env: NodeJS.ProcessEnv): string | null {
  if (env.SKIP_PROOF_SERVER_RESTART) return null;
  const { proofServerUrl } = getMidnightNodeConfig(env);
  return /127\.0\.0\.1|localhost/.test(proofServerUrl) ? proofServerUrl : null;
}

/**
 * Keep the LOCAL proof server alive across a long sequential run.
 *
 * Heavy proofs accumulate memory (fileParallelism is off, so one file follows another against one
 * server), and a never-restarted server dies late in the suite. The next prove then fails with
 * ECONNREFUSED, an hour in, naming nothing.
 *
 * Two hooks, because a recycle after each file is not enough on its own:
 * - `beforeAll` refuses to start a file against a dead server. The previous file's recycle can
 *   have failed, or the server can have died after it.
 * - `afterAll` reports the container's state, THEN recycles. Reporting first is the point: the
 *   restart hides a mid-file death, so without this a server that died is invisible in a run that
 *   otherwise passes.
 *
 * Neither hook fails the run when docker is unavailable. A missing local server surfaces as the
 * test's own error, which is no worse than before.
 */
function installProofServerRecycle(): void {
  beforeAll(async () => {
    const url = localProofServerUrl(injectE2eEnv());
    if (url === null) return;
    if (await proofServerAnswers(url)) return;
    console.warn(
      `proof server not answering before this file; container: ${await proofServerContainerState()}`,
    );
    try {
      await execFileAsync("docker", ["restart", PROOF_SERVER_CONTAINER]);
    } catch (error) {
      console.warn(`proof-server restart skipped (docker unavailable?): ${String(error)}`);
      return;
    }
    await waitForProofServer(url, 3 * MINUTE);
  }, 5 * MINUTE);

  afterAll(async () => {
    const url = localProofServerUrl(injectE2eEnv());
    if (url === null) return;
    console.log(`proof server after this file: ${await proofServerContainerState()}`);
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
