import { afterEach, describe, expect, it, vi } from "vitest";

import { withOperationProgress } from "../src/operation-progress.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("operation progress", () => {
  it("reports elapsed and remaining time, then clears the heartbeat", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = withOperationProgress(
      "proof abc",
      () =>
        new Promise<number>((resolve) =>
          setTimeout(() => {
            resolve(42);
          }, 11_000),
        ),
      Date.now() + 20_000,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(result).resolves.toBe(42);
    expect(log).toHaveBeenCalledWith("proof abc: 10.0s elapsed, 10.0s remaining");
    expect(vi.getTimerCount()).toBe(0);
  });
});
