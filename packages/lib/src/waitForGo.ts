import { open } from "node:fs/promises";

const NEWLINE = 0x0a;

/**
 * Wait until the operator hits Enter in the terminal, for step-through runs.
 * Input is read from `/dev/tty` directly because vitest runs tests in
 * workers, where `process.stdin` is not attached to the real terminal.
 * Output goes through console.log, NOT the tty, because vitest's live
 * reporter redraws its summary block in place and erases direct tty writes;
 * console output is coordinated with the reporter and survives.
 *
 * The read is asynchronous and byte-by-byte on purpose. Asynchronous, so the
 * event loop stays free while the operator thinks: vitest handles Ctrl-C
 * through a SIGINT listener, which only runs on a free loop, and its live
 * summary keeps redrawing. Byte-by-byte, because a streaming reader
 * (fs.createReadStream + readline) eagerly queues a second read(2) on the
 * tty right after delivering the first line. destroy() cannot cancel that
 * in-flight threadpool read, and the orphaned reader swallows the next Enter
 * keypress, making every later pause require two Enters. One-byte reads up
 * to the newline consume exactly one line and leave nothing in flight.
 * Crashes loudly if the tty cannot be opened: this is only ever called when
 * the operator explicitly opts into step-through mode at an interactive
 * terminal.
 *
 * @param index - 1-based position of the next step/test in its sequence.
 * @param total - Total number of steps/tests in the sequence.
 * @param name - The name of the step/test about to run.
 * @param ttyPath - The terminal to read the Enter from. Defaults to `/dev/tty`.
 * @returns Resolves once the operator has hit Enter, or the input has ended.
 * @throws {Error} If `ttyPath` cannot be opened for reading.
 */
export async function waitForGo(
  index: number,
  total: number,
  name: string,
  ttyPath = "/dev/tty",
): Promise<void> {
  console.log(
    `\n${"━".repeat(72)}\n⏸️   PAUSED (step through mode active)\n▶️    Hit enter to run next test:\n▶  TEST ${String(index)}/${String(total)} "${name}".`,
  );

  const tty = await open(ttyPath, "r");
  try {
    const byte = new Uint8Array(1);
    let byteValue: number | undefined;
    // Canonical tty mode: the first read completes once a full line is
    // entered, then the line's bytes drain one read at a time.
    do {
      const { bytesRead } = await tty.read(byte, 0, 1, null);
      if (bytesRead === 0) return;
      byteValue = byte[0];
    } while (byteValue !== NEWLINE);
  } finally {
    await tty.close();
  }
}
