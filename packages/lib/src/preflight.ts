import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Check transport reachability. Protocol readiness is checked by the subsequent setup steps.
 *
 * @param name - Human-readable service name for the error message.
 * @param url - The endpoint to probe.
 * @throws {Error} If the request cannot reach the service at all, with a hint to
 *   start the docker stack.
 */
export async function assertHttpReachable(name: string, url: string): Promise<void> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      `${name} is not reachable at ${url}. Start the local Midnight stack with \`docker compose up -d\` at the repo root. (${String(error)})`,
      { cause: error },
    );
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
      `\`${command} ${args.join(" ")}\` failed. Verify ${command} is installed and on PATH. (${String(error)})`,
      { cause: error },
    );
  }
}
