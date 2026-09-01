// Offline unit test for the subprocess failure shape: it spawns a real,
// hermetic node child (no stack, no docker) that prints more than the message
// tail quotes and then exits non-zero. The full output is what callers match
// markers and transient-failure strings against, so its survival is the point.

import { describe, expect, it } from "vitest";

import { CommandError, runCommand } from "../src/exec.ts";

// Comfortably more than the 20 lines the error message quotes, and zero-padded
// so an early label is not a substring of a later one.
const NOISY_LINE_COUNT = 40;
const noisyLabel = (line: number): string => `line-${String(line).padStart(2, "0")}`;

describe("runCommand", () => {
  it("rejects with a CommandError carrying the full output, while the message keeps the tail", async () => {
    const script =
      `for (let i = 1; i <= ${String(NOISY_LINE_COUNT)}; i++) ` +
      `console.log("line-" + String(i).padStart(2, "0")); ` +
      `console.error("the failure reason"); process.exit(1);`;

    let caught: unknown;
    try {
      await runCommand("node", ["-e", script], process.env, 60_000);
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof CommandError)) {
      throw new Error(`expected a CommandError, got ${String(caught)}`);
    }
    expect(caught.output).toContain(noisyLabel(1));
    expect(caught.output).toContain(noisyLabel(NOISY_LINE_COUNT));
    expect(caught.output).toContain("the failure reason");
    expect(caught.message).not.toContain(noisyLabel(1));
    expect(caught.message).toContain(noisyLabel(NOISY_LINE_COUNT));
    expect(caught.message).toContain("exited with code 1");
  });
});
