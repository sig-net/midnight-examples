import { describe, expect, it, vi } from "vitest";

import { executeSetupPipeline, type SetupStep } from "../src/setup-pipeline.ts";

const state = vi.hoisted(() => ({ closed: 0 }));
vi.mock("@sig-net/midnight-contract-deploy", () => ({
  getMidnightNodeConfig: () => ({}),
  WalletRegistry: class {
    close(): Promise<void> {
      state.closed += 1;
      return Promise.resolve();
    }
  },
}));
vi.mock("../src/output.ts", () => ({ stepHeader: vi.fn() }));

describe("executeSetupPipeline", () => {
  it("threads one accumulator through ordered steps and closes its wallet owner", async () => {
    state.closed = 0;
    const env: NodeJS.ProcessEnv = {};
    const steps: readonly SetupStep[] = [
      [
        "first",
        (current) => {
          current.VALUE = "prepared";
        },
      ],
      [
        "second",
        (current) => {
          expect(current.VALUE).toBe("prepared");
          current.RESULT = "ready";
        },
      ],
    ];
    expect(await executeSetupPipeline(env, steps)).toBe(env);
    expect(env.RESULT).toBe("ready");
    expect(state.closed).toBe(1);
  });
  it("closes wallets after failure and never executes a later step", async () => {
    state.closed = 0;
    const later = vi.fn();
    await expect(
      executeSetupPipeline({}, [
        [
          "failure",
          () => {
            throw new Error("setup failed");
          },
        ],
        ["later", later],
      ]),
    ).rejects.toThrow("setup failed");
    expect(later).not.toHaveBeenCalled();
    expect(state.closed).toBe(1);
  });
});
