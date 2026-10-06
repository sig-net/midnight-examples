import type { FacadeState, WalletFacade } from "@sig-net/midnight-contract-deploy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForFacadeState } from "../src/wallet.ts";

const STATE = { pending: { all: [] } } as Partial<FacadeState> as FacadeState;

afterEach(() => vi.useRealTimers());

describe("wallet state deadline", () => {
  it("expires during synchronisation and ignores a late result", async () => {
    vi.useFakeTimers();
    let resolveSync: (state: FacadeState) => void = () => {
      throw new Error("promise not initialised");
    };
    const sync = new Promise<FacadeState>((resolve) => {
      resolveSync = resolve;
    });
    const waitForSyncedState = vi.fn<WalletFacade["waitForSyncedState"]>().mockReturnValue(sync);
    const facade = { waitForSyncedState } as Partial<WalletFacade> as WalletFacade;
    const predicate = vi.fn(() => true);
    const assertion: Promise<void> = (async () => {
      await expect(waitForFacadeState(facade, predicate, 100)).rejects.toThrow("100 ms");
    })();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    resolveSync(STATE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(predicate).not.toHaveBeenCalled();
    expect(waitForSyncedState).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires during polling and clears its timers", async () => {
    vi.useFakeTimers();
    const waitForSyncedState = vi.fn<WalletFacade["waitForSyncedState"]>().mockResolvedValue(STATE);
    const facade = { waitForSyncedState } as Partial<WalletFacade> as WalletFacade;
    const assertion: Promise<void> = (async () => {
      await expect(waitForFacadeState(facade, () => false, 100)).rejects.toThrow("100 ms");
    })();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(waitForSyncedState).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the first matching snapshot and clears its deadline", async () => {
    vi.useFakeTimers();
    const waitForSyncedState = vi.fn<WalletFacade["waitForSyncedState"]>().mockResolvedValue(STATE);
    const facade = { waitForSyncedState } as Partial<WalletFacade> as WalletFacade;
    await expect(waitForFacadeState(facade, () => true, 100)).resolves.toBe(STATE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
