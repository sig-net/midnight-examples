// Offline unit test of when the vault starts refunding an unsent Tron withdrawal. No
// stack, no env gate: it runs in every `yarn test`.

import { describe, expect, it } from "vitest";

import { tronWithdrawRefundOpensAtMs } from "../src/flows/refund-unsent-tron-withdraw.ts";

describe("tronWithdrawRefundOpensAtMs", () => {
  // tronWithdrawSendMinRemainingSeconds() is 60: the refund opens 60 s before the
  // expiration's whole second.
  it.each([
    ["an expiration on a whole second", 1_800_003_600_000n, 1_800_003_540_000n],
    ["an expiration inside a second, floored", 1_800_003_600_999n, 1_800_003_540_000n],
  ] as const)("opens for %s", (_name, expiration, opensAt) => {
    expect(tronWithdrawRefundOpensAtMs(expiration)).toBe(opensAt);
  });
});
