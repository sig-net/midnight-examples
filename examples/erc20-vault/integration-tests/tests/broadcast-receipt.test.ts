import { JsonRpcProvider, Transaction, type TransactionReceipt, Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import type { VaultContext } from "../src/vault-context.ts";

const CONTEXT = { evmRpcUrl: "http://localhost:1" } as VaultContext;

afterEach(() => vi.restoreAllMocks());

describe("already mined receipt reporting", () => {
  it.each([
    { status: 1, tolerateRevert: false },
    { status: 0, tolerateRevert: true },
  ])("reports status $status without rebroadcast", async ({ status, tolerateRevert }) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wallet = new Wallet(`0x${"01".repeat(32)}`);
    const transaction = Transaction.from(
      await wallet.signTransaction({
        chainId: 1,
        nonce: 0,
        to: wallet.address,
        gasLimit: 100_000n,
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        type: 2,
      }),
    );
    const receipt = {
      hash: transaction.hash,
      status,
      blockNumber: 42,
      gasUsed: 50_000n,
      gasPrice: 2_000_000_000n,
      fee: 100_000_000_000_000n,
    } as TransactionReceipt;
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue(receipt);
    const broadcast = vi.spyOn(JsonRpcProvider.prototype, "broadcastTransaction");
    await expect(broadcastEvm(CONTEXT, { transaction, tolerateRevert })).resolves.toBe(receipt);
    expect(broadcast).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("actual gas fee 0.0001 ETH"));
  });
});
