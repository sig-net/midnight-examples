import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "task11-reset-")),
    instance: "same",
    missing: false,
    disposed: 0,
    destroyed: 0,
    send: vi.fn(),
  };
});
vi.mock("@sig-net/midnight-examples-lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  REPO_ROOT: state.root,
}));
vi.mock("@midnight-ntwrk/midnight-js-indexer-public-data-provider", () => ({
  indexerPublicDataProvider: () => ({
    queryContractState: () => Promise.resolve(state.missing ? undefined : {}),
    dispose: () => {
      state.disposed++;
      return Promise.resolve();
    },
  }),
}));
vi.mock("ethers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  JsonRpcProvider: class {
    send(method: string, params: unknown[]) {
      state.send(method, params);
      return Promise.resolve({ instanceId: state.instance });
    }
    destroy() {
      state.destroyed++;
    }
  },
}));
vi.mock("../src/setup-vault.ts", () => ({ vaultSetupSteps: vi.fn() }));
vi.mock("../src/initialise-vault.ts", () => ({ initialiseVault: vi.fn() }));
vi.mock("../src/local-artifacts.ts", () => ({ verifyLocalArtifacts: vi.fn() }));
const { resetLocalConfiguration, setupLocalVault } = await import("../src/setup-local.ts");
const directory = join(state.root, ".local-demo");
const saved =
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS=signet\nMIDNIGHT_VAULT_CONTRACT_ADDRESS=vault\nMIDNIGHT_USER_SEED=private-testing-value\n";
beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  writeFileSync(join(directory, "setup.env"), saved);
  writeFileSync(
    join(directory, "instance.json"),
    JSON.stringify({ instanceId: "same", markerAddress: "marker", markerCode: "code" }),
  );
  writeFileSync(join(state.root, ".env"), saved + "SEPOLIA_FORK_RPC_URL=private-upstream\n");
  state.instance = "same";
  state.missing = false;
  state.disposed = 0;
  state.destroyed = 0;
  state.send.mockClear();
});
afterAll(() => {
  rmSync(state.root, { recursive: true, force: true });
});
describe("local configuration ownership", () => {
  it("refuses a current stack without modifying saved credentials", async () => {
    await expect(resetLocalConfiguration()).rejects.toThrow("still current");
    expect(readFileSync(join(directory, "setup.env"), "utf8")).toBe(saved);
    expect(state.disposed).toBe(1);
    expect(state.destroyed).toBe(1);
  });
  it.each(["midnight", "anvil"])(
    "clears generated addresses after a %s reset and preserves private input",
    async (kind) => {
      state.missing = kind === "midnight";
      state.instance = kind === "anvil" ? "replacement" : "same";
      await resetLocalConfiguration();
      const root = readFileSync(join(state.root, ".env"), "utf8");
      expect(root).toContain("SEPOLIA_FORK_RPC_URL=private-upstream");
      expect(root).toContain("MIDNIGHT_USER_SEED=private-testing-value");
      expect(root).not.toContain("CONTRACT_ADDRESS");
      expect(existsSync(join(directory, "instance.json"))).toBe(false);
      expect(state.send.mock.calls.filter(([method]) => method === "anvil_setCode")).toHaveLength(
        kind === "midnight" ? 1 : 0,
      );
      expect(state.disposed).toBe(1);
      expect(state.destroyed).toBe(1);
    },
  );
  it("refuses manually changed address configuration", async () => {
    state.missing = true;
    writeFileSync(join(state.root, ".env"), "MIDNIGHT_VAULT_CONTRACT_ADDRESS=manual\n");
    await expect(resetLocalConfiguration()).rejects.toThrow("User-owned");
    expect(readFileSync(join(directory, "setup.env"), "utf8")).toBe(saved);
  });
  it("refuses user-owned UI configuration before setup", async () => {
    const ui = join(state.root, "ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, ".env.local"), "USER_VALUE=preserve\n");
    await expect(setupLocalVault({}, ui)).rejects.toThrow("user-owned");
    expect(state.send).not.toHaveBeenCalled();
  });
});
