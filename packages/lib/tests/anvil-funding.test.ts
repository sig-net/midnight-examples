import type * as ethersModule from "ethers";
import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureAnvilErc20Balance, ensureAnvilEthBalance } from "../src/anvil-funding.ts";

const state = vi.hoisted(() => ({ balance: 0n, failRead: false }));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof ethersModule>();
  return {
    ethers: {
      ...actual.ethers,
      Contract: class {
        getFunction(): () => Promise<bigint> {
          return () => {
            if (state.failRead && state.balance !== 0n) throw new Error("read failed");
            return Promise.resolve(state.balance);
          };
        }
      },
    },
  };
});

beforeEach(() => {
  state.balance = 0n;
  state.failRead = false;
});

describe("Anvil funding targets", () => {
  it.each([0n, 10n, 20n])("preserves native balances above the target: %s", async (balance) => {
    const provider = new ethers.JsonRpcProvider();
    vi.spyOn(provider, "getBalance").mockResolvedValue(balance);
    const send = vi.spyOn(provider, "send").mockResolvedValue(null);
    try {
      await ensureAnvilEthBalance(provider, "0x1111111111111111111111111111111111111111", 10n);
      expect(send).toHaveBeenCalledTimes(balance < 10n ? 1 : 0);
    } finally {
      provider.destroy();
    }
  });

  it.each([0n, 10n, 20n])("preserves ERC20 balances above the target: %s", async (balance) => {
    state.balance = balance;
    const provider = new ethers.JsonRpcProvider();
    vi.spyOn(provider, "getStorage").mockImplementation(() =>
      Promise.resolve(ethers.toBeHex(state.balance, 32)),
    );
    const send = vi.spyOn(provider, "send").mockImplementation((_method, params) => {
      if (!Array.isArray(params) || typeof params[2] !== "string") throw new Error("invalid write");
      state.balance = BigInt(params[2]);
      return Promise.resolve(null);
    });
    try {
      await ensureAnvilErc20Balance(
        provider,
        "0x2222222222222222222222222222222222222222",
        "0x1111111111111111111111111111111111111111",
        10n,
      );
      expect(state.balance).toBe(balance < 10n ? 10n : balance);
      expect(send).toHaveBeenCalledTimes(balance < 10n ? 3 : 0);
    } finally {
      provider.destroy();
    }
  });

  it("restores the probed storage word when balance observation fails", async () => {
    state.failRead = true;
    const provider = new ethers.JsonRpcProvider();
    vi.spyOn(provider, "getStorage").mockResolvedValue(ethers.toBeHex(0n, 32));
    vi.spyOn(provider, "send").mockImplementation((_method, params) => {
      if (!Array.isArray(params) || typeof params[2] !== "string") throw new Error("invalid write");
      state.balance = BigInt(params[2]);
      return Promise.resolve(null);
    });
    try {
      await expect(
        ensureAnvilErc20Balance(
          provider,
          "0x2222222222222222222222222222222222222222",
          "0x1111111111111111111111111111111111111111",
          10n,
        ),
      ).rejects.toThrow("read failed");
      expect(state.balance).toBe(0n);
    } finally {
      provider.destroy();
    }
  });
});
