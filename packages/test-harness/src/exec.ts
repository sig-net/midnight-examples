// Subprocess plumbing for SETUP steps that must shell out: docker compose and
// the zk compile root scripts. Flows and contract deploys are in-process typed
// function calls, so nothing under a flow should ever need this module.

import { spawn } from "node:child_process";

import { REPO_ROOT } from "@sig-net/midnight-examples-lib";

/**
 * Run a root-level package script (`yarn run <script>` at {@link REPO_ROOT}),
 * streaming its output live to the console and capturing stdout.
 *
 * @param script - Name of the root package.json script (e.g. `compile:erc20-vault:zk`).
 * @param env - Full environment for the child process (pass the suite's env
 *   accumulator, not `process.env`).
 * @param timeoutMs - Kill the child and fail after this many milliseconds.
 * @returns The captured stdout.
 * @throws {CommandError} If the script exits non-zero, is killed by a signal, or times out.
 */
export async function runRootScript(
  script: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  return await runCommand("yarn", ["run", script], env, timeoutMs);
}

// How much of the combined output the error MESSAGE quotes. The full output
// stays on the error as `output` for callers that match on it.
const MESSAGE_TAIL_LINES = 20;

/**
 * A failed subprocess: the message quotes the last {@link MESSAGE_TAIL_LINES}
 * lines of the child's output, and `output` carries all of it.
 *
 * Match on `output`, never on `message`, when a decision depends on something
 * the child printed: a verbose crash pushes any earlier line out of the tail
 * the message quotes.
 */
export class CommandError extends Error {
  /** The child's combined stdout and stderr, in the order the child wrote it. */
  readonly output: string;

  /**
   * @param message - Human-readable failure summary, ending in the output tail.
   * @param output - The child's full combined stdout and stderr.
   */
  constructor(message: string, output: string) {
    super(message);
    this.name = "CommandError";
    this.output = output;
  }
}

/**
 * Run an arbitrary command at {@link REPO_ROOT}, streaming its output live
 * to the console and capturing stdout. {@link runRootScript} is the yarn
 * specialization of this.
 *
 * @param command - The executable to spawn (e.g. `docker`).
 * @param args - Arguments passed verbatim (no shell interpretation).
 * @param env - Full environment for the child process (pass the suite's env
 *   accumulator, not `process.env`).
 * @param timeoutMs - Kill the child and fail after this many milliseconds.
 * @returns The captured stdout.
 * @throws {CommandError} If the command exits non-zero, is killed by a signal, or times out.
 */
export async function runCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let combined = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      combined += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = combined.split("\n").slice(-MESSAGE_TAIL_LINES).join("\n");
      reject(
        new CommandError(
          `${command} ${args.join(" ")} ${signal ? `killed by ${signal} (timeout ${String(timeoutMs)}ms?)` : `exited with code ${String(code)}`}\n--- output tail ---\n${tail}`,
          combined,
        ),
      );
    });
  });
}
