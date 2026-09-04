// The transient-failure predicate behind retryWhileDustGenerates. The failure
// it must recognise reaches it in several shapes (the wallet SDK's own error,
// an error wrapping it as `cause`, a tagged object), and the cost of missing
// one is a fresh local stack failing outright instead of waiting out the few
// minutes a young chain needs to generate spendable dust.

import { describe, expect, it } from "vitest";

import { isDustGenerationFailure } from "../src/steps.ts";

/** A case: the thrown value, and whether the step must keep retrying on it. */
interface DustFailureCase {
  readonly name: string;
  readonly error: unknown;
  readonly transient: boolean;
}

const CASES: readonly DustFailureCase[] = [
  {
    name: "the wallet SDK's insufficient-funds error itself",
    error: new Error("Wallet.InsufficientFunds: not enough Dust to pay the fee"),
    transient: true,
  },
  {
    name: "an error whose message names the balancing failure",
    error: new Error("could not balance dust for this transaction"),
    transient: true,
  },
  {
    name: "an error wrapping the insufficient-funds error as its cause",
    error: new Error("deploy failed", { cause: new Error("Wallet.InsufficientFunds") }),
    transient: true,
  },
  {
    name: "a cause two levels down",
    error: new Error("deploy failed", {
      cause: new Error("submit failed", { cause: new Error("could not balance dust") }),
    }),
    transient: true,
  },
  {
    name: "a tagged object rather than an Error",
    error: { _tag: "Wallet.InsufficientFunds", required: 1n },
    transient: true,
  },
  {
    name: "an unrelated deploy failure",
    error: new Error("contract state for 0xabc vanished mid-deploy"),
    transient: false,
  },
  {
    name: "a node rejection that must fail fast",
    error: new Error("Malformed(BalanceCheckOverspend)"),
    transient: false,
  },
];

describe("isDustGenerationFailure", () => {
  it.each(CASES)("$name", ({ error, transient }) => {
    expect(isDustGenerationFailure(error)).toBe(transient);
  });
});
