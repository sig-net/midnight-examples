// Environment preflight checks: is the local Midnight stack up, is the
// compact compiler installed. Pure reachability probes — no protocol traffic.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// How long a reachability probe keeps retrying before giving up. Long enough
// for a `docker compose up -d` typed seconds earlier to finish booting its
// services (the node takes tens of seconds to serve /health), short enough
// that a genuinely absent stack still fails with the hint promptly.
const REACHABILITY_PATIENCE_MS = 90_000;
const REACHABILITY_RETRY_DELAY_MS = 3_000;

/**
 * Assert an HTTP endpoint is reachable, waiting out a service that is still
 * booting. ANY http response counts as reachable (the indexer's GraphQL
 * endpoint answers GETs with 400, the proof server's root with 404 — both
 * prove the service is up); only a network-level failure (refused,
 * unresolvable, timeout) counts against it, and those are retried until the
 * patience window closes: a stack started moments ago is the common case,
 * not an error.
 *
 * @param name - Human-readable service name for the error message.
 * @param url - The endpoint to probe.
 * @throws {Error} If the service stays unreachable for the whole patience
 *   window, with a hint to start the docker stack.
 */
export async function assertHttpReachable(name: string, url: string): Promise<void> {
  const deadline = Date.now() + REACHABILITY_PATIENCE_MS;
  let waiting = false;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `${name} is not reachable at ${url} — is the local Midnight stack up? Start it with \`docker compose up -d\` at the repo root. (${String(error)})`,
          { cause: error },
        );
      }
      if (!waiting) {
        waiting = true;
        console.log(
          `waiting for ${name} at ${url} (a just-started stack takes a moment to boot)...`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, REACHABILITY_RETRY_DELAY_MS));
    }
  }
}

/**
 * Assert an executable is on PATH and runs, by executing it once.
 *
 * @param command - The executable name (e.g. `compact`).
 * @param args - Arguments for a cheap invocation (e.g. `["--version"]`).
 * @throws {Error} If the command is missing or exits non-zero, with install hint.
 */
export async function assertCommandAvailable(command: string, args: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
    const [firstLine = ""] = stdout.trim().split("\n");
    console.log(`${command} ${args.join(" ")}: ${firstLine}`);
  } catch (error) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed — is the ${command} toolchain installed and on PATH? (${String(error)})`,
      { cause: error },
    );
  }
}
