// The one node rejection the setup steps translate: which errors get the
// stack-reset hint, and that every other error passes through untouched.

import { describe, expect, it } from "vitest";

import { explainDustSpendRejection } from "../src/steps.ts";

describe("explainDustSpendRejection", () => {
  it("returns what the action resolves to", async () => {
    await expect(explainDustSpendRejection("step", () => Promise.resolve(42))).resolves.toBe(42);
  });

  const EXPLAINED: readonly string[] = [
    "1010: Invalid Transaction: Custom error: 170",
    "submission failed: Custom error: 170",
    "InvalidDustSpendProof",
  ];

  it.each(EXPLAINED)("wraps %j with the stack-reset hint, keeping the cause", async (text) => {
    const original = new Error(text);
    const wrapped = await explainDustSpendRejection("deploy", () => Promise.reject(original)).catch(
      (error: unknown) => error,
    );
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(original);
    expect((wrapped as Error).message).toContain("deploy: node rejected the dust spend");
    expect((wrapped as Error).message).toContain(text);
    expect((wrapped as Error).cause).toBe(original);
  });

  const PASSED_THROUGH: readonly string[] = [
    "wallet holds 1010 NIGHT",
    "connect ECONNREFUSED 127.0.0.1:1010",
    "timed out waiting for block 1010",
    "Custom error: 171",
    "insufficient funds",
  ];

  it.each(PASSED_THROUGH)("rethrows %j as the same object", async (text) => {
    const original = new Error(text);
    const thrown = await explainDustSpendRejection("deploy", () => Promise.reject(original)).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBe(original);
  });
});
