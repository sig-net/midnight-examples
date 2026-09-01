// Offline unit tests for the retry policy every fee-paying setup step runs
// through. The retry loop sleeps 15s between attempts, so the retrying cases
// drive vitest's fake timers rather than the clock.

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandError } from "../src/exec.ts";
import { NonRetryableError, retryWhileDustGenerates } from "../src/steps.ts";

const RETRY_DELAY_MS = 15_000;

// The failure a young dev chain produces while its DUST is still generating.
const TRANSIENT_MESSAGE = "Wallet.InsufficientFunds: could not balance dust";

describe("retryWhileDustGenerates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rethrows a NonRetryableError without a second attempt, even when it quotes a trigger string", async () => {
    let attempts = 0;
    const action = (): Promise<never> => {
      attempts++;
      return Promise.reject(
        new NonRetryableError(`base deploy submitted, then ${TRANSIENT_MESSAGE}`),
      );
    };

    await expect(retryWhileDustGenerates("deploy vault contract", action)).rejects.toThrow(
      NonRetryableError,
    );
    expect(attempts).toBe(1);
  });

  it("retries a transient insufficient-dust failure and resolves once the wallet can pay", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const action = (): Promise<string> => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error(TRANSIENT_MESSAGE))
        : Promise.resolve("0200aa");
    };

    const pending = retryWhileDustGenerates("deploy signet contract", action);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    await expect(pending).resolves.toBe("0200aa");
    expect(attempts).toBe(2);
  });

  it("retries on a trigger that a CommandError carries in its output but not in its message tail", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const action = (): Promise<string> => {
      attempts++;
      return attempts === 1
        ? Promise.reject(
            new CommandError(
              "yarn deploy exited with code 1\n--- output tail ---\nstack unwound",
              `${TRANSIENT_MESSAGE}\nstack unwound`,
            ),
          )
        : Promise.resolve("0200bb");
    };

    const pending = retryWhileDustGenerates("deploy vault contract", action);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    await expect(pending).resolves.toBe("0200bb");
    expect(attempts).toBe(2);
  });

  it("rethrows a failure that matches no trigger on the first attempt", async () => {
    let attempts = 0;
    const action = (): Promise<never> => {
      attempts++;
      return Promise.reject(new Error("MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required"));
    };

    await expect(retryWhileDustGenerates("deploy vault contract", action)).rejects.toThrow(
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required",
    );
    expect(attempts).toBe(1);
  });
});
