import { afterEach, describe, expect, it, vi } from "vitest";

import { fundingSummary, logEvmFeeCap } from "../src/evm-logging.ts";
import { formatEvmReceipt } from "../src/flows/broadcast-evm.ts";
import { PollProgress } from "../src/poll-progress.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("funding and receipt units", () => {
  it("shows a decimal token shortfall", () => {
    expect(fundingSummary(40_000n, 100_000n, 6, "USDC")).toBe(
      "available 0.04 USDC, required 0.1 USDC, shortfall 0.06 USDC",
    );
  });
  it.each([
    { gas: 100_000n, fee: "0.003" },
    { gas: 500_000n, fee: "0.015" },
  ])("prices $gas gas as a maximum", ({ gas, fee }) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvmFeeCap("request", "payer", gas, 30_000_000_000n, 1_000_000_000n);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`maximum gas fee ${fee} ETH`));
  });
  it.each([
    { status: 1, label: "succeeded" },
    { status: 0, label: "reverted" },
  ])("reports receipt status $status and actual fee", ({ status, label }) => {
    const receipt = {
      hash: "0xabc",
      status,
      blockNumber: 42,
      gasUsed: 50_000n,
      gasPrice: 2_000_000_000n,
      fee: 100_000_000_000_000n,
    };
    expect(formatEvmReceipt(receipt, 3_000_000_000_000_000n)).toBe(
      `0xabc: ${label}, block 42, gas used 50000, effective gas price 2.0 gwei, actual gas fee 0.0001 ETH, signed maximum gas fee 0.003 ETH`,
    );
  });
});

describe("poll diagnostics", () => {
  it.each(["no response observed", "2 attestation posts rejected", "execution observation failed"])(
    'retains "$status" at timeout',
    (status) => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const progress = new PollProgress("request abc", 30_000);
      progress.update(status);
      vi.advanceTimersByTime(30_000);
      expect(progress.summary()).toContain(`${status}, 30.0s elapsed, 0.0s remaining`);
    },
  );
  it("deduplicates warnings while retaining the latest error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const progress = new PollProgress("request abc", 30_000);
    progress.failure("trace", "RPC unavailable");
    progress.failure("trace", "RPC timed out");
    expect(warn).toHaveBeenCalledOnce();
    expect(progress.summary()).toContain("Last failure: RPC timed out");
  });
});
