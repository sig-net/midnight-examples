// Offline unit tests of the step-through pause, over a FIFO standing in for
// /dev/tty: the test is the "operator", writing the Enter from the same
// process. That only works because the pause leaves the event loop free,
// which is the property vitest's Ctrl-C handling depends on.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { waitForGo } from "../src/waitForGo.ts";

let dir: string;
let fifo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wait-for-go-"));
  fifo = join(dir, "tty");
  execFileSync("mkfifo", [fifo]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Open the FIFO's writer side (blocks until the pause opens the reader side). */
const openWriter = (): ReturnType<typeof open> => open(fifo, "w");

describe("waitForGo", () => {
  /** What the operator types, and whether the pause resolves on it. */
  interface TypedCase {
    readonly name: string;
    readonly typed: string;
  }

  const RELEASES: readonly TypedCase[] = [
    { name: "a bare Enter", typed: "\n" },
    { name: "a word then Enter", typed: "asdf\n" },
  ];

  it.each(RELEASES)("resolves on $name with the event loop free meanwhile", async ({ typed }) => {
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 50);

    const pause = waitForGo(2, 5, "step two", fifo);
    const writer = await openWriter();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(timerFired, "the event loop must keep turning during the pause").toBe(true);

    await writer.write(typed);
    await expect(pause).resolves.toBeUndefined();
    await writer.close();
    clearTimeout(timer);
  });

  it("resolves when the input ends without an Enter", async () => {
    const pause = waitForGo(2, 5, "step two", fifo);
    const writer = await openWriter();
    await writer.write("no newline");
    await writer.close();
    await expect(pause).resolves.toBeUndefined();
  });

  it("consumes exactly one line, leaving the next Enter for the next pause", async () => {
    const pause = waitForGo(2, 5, "step two", fifo);
    const writer = await openWriter();
    await writer.write("go\nnext\n");
    await expect(pause).resolves.toBeUndefined();

    const reader = await open(fifo, "r");
    try {
      const rest = new Uint8Array(16);
      const { bytesRead } = await reader.read(rest, 0, rest.length, null);
      expect(new TextDecoder().decode(rest.subarray(0, bytesRead))).toBe("next\n");
    } finally {
      await reader.close();
      await writer.close();
    }
  });
});
