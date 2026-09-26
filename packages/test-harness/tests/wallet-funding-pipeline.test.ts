vi.mock("@sig-net/midnight-contract-deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof funding>()),
}));

import * as funding from "@sig-net/midnight-contract-deploy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fundWalletsFromRoot, type WalletFundingRecipient } from "../src/wallet-funding.ts";

const ROOT_SEED = "01".repeat(32);
const RECIPIENTS: readonly WalletFundingRecipient[] = [2, 3, 4, 5, 6].map((value) => ({
  seed: value.toString(16).padStart(2, "0").repeat(32),
  label: `child ${String(value)}`,
  amount: 100n,
}));
const CONFIG = funding.getMidnightNodeConfig({ NETWORK_ID: "stagenet" });
const KEYS: ReadonlyMap<string, funding.AccountKeys> = new Map(
  [ROOT_SEED, ...RECIPIENTS.map(({ seed }) => seed)].map((seed) => [
    seed,
    funding.deriveAccountKeys(seed, CONFIG.networkId),
  ]),
);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("promise not initialised");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("promise not initialised");
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function arrange() {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const registry = new funding.WalletRegistry(CONFIG);
  const balances = new Map<string, { night: bigint; dust: bigint }>();
  const facades = new Map<string, funding.WalletFacade>();
  const keysByAddress = new Map<string, string>();
  for (const [seed, keys] of KEYS) {
    const balance = { night: seed === ROOT_SEED ? 1000n : 0n, dust: 0n };
    balances.set(seed, balance);
    const unshielded = {
      get balances(): Record<string, bigint> {
        return { night: balance.night };
      },
    } as funding.FacadeState["unshielded"];
    const dust = { balance: (): bigint => balance.dust } as Partial<
      funding.FacadeState["dust"]
    > as funding.FacadeState["dust"];
    const state = {
      unshielded,
      dust,
      pending: { all: [] },
    } as Partial<funding.FacadeState> as funding.FacadeState;
    const facade = {
      waitForSyncedState: vi
        .fn<funding.WalletFacade["waitForSyncedState"]>()
        .mockResolvedValue(state),
    } as Partial<funding.WalletFacade> as funding.WalletFacade;
    facades.set(seed, facade);
    keysByAddress.set(funding.deriveAddresses(keys, CONFIG.networkId).unshielded, seed);
  }
  const open = vi.spyOn(registry, "wallet").mockImplementation((seed, label) => {
    const keys = KEYS.get(seed);
    const facade = facades.get(seed);
    if (!keys || !facade) throw new Error("missing fixture wallet");
    return Promise.resolve({ label, keys, facade });
  });
  const transfer = vi
    .spyOn(funding, "transferNight")
    .mockImplementation((_facade, _keys, _state, address) => {
      const seed = keysByAddress.get(address);
      const balance = seed === undefined ? undefined : balances.get(seed);
      if (!balance) throw new Error("missing fixture recipient");
      balance.night = 100n;
      return Promise.resolve("transaction");
    });
  const ready = vi.spyOn(funding, "ensureFeeReady").mockResolvedValue(10n);
  return { registry, balances, facades, transfer, ready, open };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pipelined wallet funding", () => {
  it("overlaps child confirmations, bounds concurrency and waits for the final child", async () => {
    const { registry, transfer, ready } = arrange();
    const first = deferred<bigint>();
    const second = deferred<bigint>();
    const last = deferred<bigint>();
    ready
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(last.promise);
    const result = fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS.slice(0, 3), 2);
    const settled = vi.fn();
    void result.then(settled);
    await vi.waitFor(() => {
      expect(ready).toHaveBeenCalledTimes(2);
    });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    first.resolve(10n);
    await vi.waitFor(() => {
      expect(ready).toHaveBeenCalledTimes(3);
    });
    second.resolve(10n);
    expect(settled).not.toHaveBeenCalled();
    last.resolve(10n);
    await expect(result).resolves.toBe(3);
  });

  it("observes an early child rejection while the next root transfer is blocked", async () => {
    const { registry, transfer, ready } = arrange();
    const child = deferred<bigint>();
    const nextTransfer = deferred<string>();
    const failure = new Error("child registration failed");
    ready.mockReturnValueOnce(child.promise);
    const realTransfer = transfer.getMockImplementation();
    if (!realTransfer) throw new Error("missing fixture transfer");
    transfer.mockImplementationOnce(realTransfer).mockImplementationOnce(async (...args) => {
      await nextTransfer.promise;
      return realTransfer(...args);
    });
    const result = fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS, 4);
    const assertion: Promise<void> = (async () => {
      await expect(result).rejects.toBe(failure);
    })();
    await vi.waitFor(() => {
      expect(transfer).toHaveBeenCalledTimes(2);
    });
    child.reject(failure);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    nextTransfer.resolve("second transfer");
    await assertion;
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("drains a started confirmation when a later root transfer fails", async () => {
    const { registry, transfer, ready } = arrange();
    const child = deferred<bigint>();
    const failure = new Error("root transfer failed");
    ready.mockReturnValueOnce(child.promise);
    const realTransfer = transfer.getMockImplementation();
    if (!realTransfer) throw new Error("missing fixture transfer");
    transfer.mockImplementationOnce(realTransfer).mockRejectedValueOnce(failure);
    const result = fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS);
    const settled = vi.fn();
    void result.then(settled, settled);
    const assertion: Promise<void> = (async () => {
      await expect(result).rejects.toBe(failure);
    })();
    await vi.waitFor(() => {
      expect(transfer).toHaveBeenCalledTimes(2);
    });
    expect(settled).not.toHaveBeenCalled();
    child.resolve(10n);
    await assertion;
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "DUST without NIGHT", night: 0n, dust: 10n, registrations: 0 },
    { name: "NIGHT without DUST", night: 100n, dust: 0n, registrations: 1 },
    { name: "NIGHT and DUST", night: 100n, dust: 10n, registrations: 0 },
  ])("reuses $name without opening root", async ({ night, dust, registrations }) => {
    const { registry, balances, transfer, ready, open } = arrange();
    const recipient = RECIPIENTS[0];
    if (!recipient) throw new Error("missing fixture recipient");
    const balance = balances.get(recipient.seed);
    if (!balance) throw new Error("missing fixture balance");
    Object.assign(balance, { night, dust });
    await expect(fundWalletsFromRoot(registry, ROOT_SEED, [recipient])).resolves.toBe(0);
    expect(open).not.toHaveBeenCalledWith(ROOT_SEED, "root");
    expect(transfer).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(registrations);
  });

  it("bounds a stalled root synchronisation without submitting a transfer", async () => {
    vi.useFakeTimers();
    const { registry, facades, transfer } = arrange();
    const root = facades.get(ROOT_SEED);
    if (!root) throw new Error("missing fixture root");
    vi.spyOn(root, "waitForSyncedState").mockReturnValue(
      new Promise<funding.FacadeState>(() => undefined),
    );
    const assertion: Promise<void> = (async () => {
      await expect(fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS)).rejects.toThrow(
        "60000 ms",
      );
    })();
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(transfer).not.toHaveBeenCalled();
  });

  it("waits for root pending inputs before building the next transfer", async () => {
    vi.useFakeTimers();
    const { registry, facades, transfer } = arrange();
    const root = facades.get(ROOT_SEED);
    if (!root) throw new Error("missing fixture root");
    const state: funding.FacadeState = await root.waitForSyncedState();
    const pending = {
      unshielded: state.unshielded,
      dust: state.dust,
      pending: { all: [{} as funding.FacadeState["pending"]["all"][number]] },
    } as Partial<funding.FacadeState> as funding.FacadeState;
    vi.spyOn(root, "waitForSyncedState")
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(state);
    const result: Promise<number> = fundWalletsFromRoot(
      registry,
      ROOT_SEED,
      RECIPIENTS.slice(0, 2),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(transfer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(transfer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(2);
  });

  it("bounds stalled child observation and does not register after timeout", async () => {
    vi.useFakeTimers();
    const { registry, facades, transfer, ready } = arrange();
    const recipient = RECIPIENTS[0];
    if (!recipient) throw new Error("missing fixture recipient");
    const child = facades.get(recipient.seed);
    if (!child) throw new Error("missing fixture child");
    const late = deferred<funding.FacadeState>();
    const state: funding.FacadeState = await child.waitForSyncedState();
    transfer.mockImplementationOnce(() => {
      vi.spyOn(child, "waitForSyncedState").mockReturnValue(late.promise);
      return Promise.resolve("transfer");
    });
    const assertion: Promise<void> = (async () => {
      await expect(fundWalletsFromRoot(registry, ROOT_SEED, [recipient])).rejects.toThrow(
        "120000 ms",
      );
    })();
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    late.resolve(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).not.toHaveBeenCalled();
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("retains both child and root failures after draining confirmations", async () => {
    const { registry, transfer, ready } = arrange();
    const child = deferred<bigint>();
    const rootFailure = new Error("root transfer failed");
    const childFailure = new Error("child registration failed");
    ready.mockReturnValueOnce(child.promise);
    const realTransfer = transfer.getMockImplementation();
    if (!realTransfer) throw new Error("missing fixture transfer");
    transfer.mockImplementationOnce(realTransfer).mockRejectedValueOnce(rootFailure);
    const result = fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS);
    const assertion: Promise<void> = (async () => {
      await expect(result).rejects.toMatchObject({ errors: [rootFailure, childFailure] });
    })();
    await vi.waitFor(() => {
      expect(transfer).toHaveBeenCalledTimes(2);
    });
    child.reject(childFailure);
    await assertion;
  });

  it.each([
    { name: "root as child", seed: ROOT_SEED },
    { name: "normalised root alias", seed: `0x${ROOT_SEED.toUpperCase()}` },
  ])("rejects $name before opening wallets", async ({ seed }) => {
    const { registry, transfer, open } = arrange();
    await expect(
      fundWalletsFromRoot(registry, ROOT_SEED, [{ seed, label: "duplicate", amount: 1n }]),
    ).rejects.toThrow("duplicate funding wallet");
    expect(open).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid concurrency %s before opening wallets",
    async (concurrency) => {
      const { registry, transfer, open } = arrange();
      await expect(
        fundWalletsFromRoot(registry, ROOT_SEED, RECIPIENTS, concurrency),
      ).rejects.toThrow("positive integer");
      expect(open).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
    },
  );
});
