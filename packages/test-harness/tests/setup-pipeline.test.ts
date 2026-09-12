import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";

import { runSetupPipeline } from "../src/setup-pipeline.ts";

const calls = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@sig-net/midnight-examples-lib", () => ({
  buildBaseEnv: () => ({ INPUT: "value" }),
  executeSetupPipeline: calls.execute,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("Vitest setup adapter", () => {
  it("does not prepare services without the integration opt-in", async () => {
    vi.stubEnv("RUN_INTEGRATION_TESTS", "");
    const provide = vi.fn();
    await runSetupPipeline({ provide } as unknown as TestProject, []);
    expect(calls.execute).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
  });
  it("delegates setup and provides only defined strings to workers", async () => {
    vi.stubEnv("RUN_INTEGRATION_TESTS", "1");
    calls.execute.mockResolvedValue({ READY: "yes", ABSENT: undefined });
    const provide = vi.fn();
    const steps = [["prepared", vi.fn()]] as const;
    await runSetupPipeline({ provide } as unknown as TestProject, steps);
    expect(calls.execute).toHaveBeenCalledWith({ INPUT: "value" }, steps);
    expect(provide).toHaveBeenCalledWith("e2eEnv", { READY: "yes" });
  });
});
