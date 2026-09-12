/**
 * Loud, uniform skip line so skipped steps are obvious in the output.
 *
 * @param step - The step that was skipped.
 * @param reason - Why it was skipped (usually: which env var is already set).
 */
export function logSkip(step: string, reason: string): void {
  console.log(`SKIPPED: ${step}: ${reason}`);
}

/**
 * Print a value the operator must save, too loud to miss.
 *
 * @param lines - The banner's body lines, printed between `=` borders.
 */
export function banner(lines: string[]): void {
  const border = "=".repeat(72);
  console.log(`\n${border}\n${lines.join("\n")}\n${border}\n`);
}

/**
 * Mark boundaries in streamed setup and flow output.
 *
 * @param index - 1-based position of the step/test in its sequence.
 * @param total - Total number of steps/tests in the sequence.
 * @param name - The step/test name to display.
 */
export function stepHeader(index: number, total: number, name: string): void {
  const border = "━".repeat(72);
  console.log(`\n${border}\n▶  STEP ${String(index)}/${String(total)}  ${name}\n${border}`);
}
