import { submitTransferTransaction } from "../src/wallet.ts";
vi.mock("@sig-net/midnight-contract-deploy", async (importOriginal) => {
  const actual = await importOriginal<typeof funding>();
  return { ...actual };
});

import * as ledger from "@midnightntwrk/ledger-v9";
import * as funding from "@sig-net/midnight-contract-deploy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureTransactionFee } from "../src/transaction-fees.ts";

const KEYS = funding.deriveAccountKeys("01".repeat(32), "stagenet");
const TRANSACTION = ledger.Transaction.fromParts("stagenet");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transaction fee readiness", () => {
  it.each([
    { name: "first call", floor: 10n, fee: 15n },
    { name: "larger call", floor: 20n, fee: 37n },
  ])(
    "uses the complete estimate for $name without funding sufficient DUST",
    async ({ floor, fee }) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const ensure = vi.spyOn(funding, "ensureFeeReady");
      const dust: Partial<funding.FacadeState["dust"]> = { balance: (): bigint => 100n };
      const state = { dust: dust as funding.FacadeState["dust"] } as funding.FacadeState;
      const estimate = vi
        .fn<funding.WalletFacade["estimateTransactionFee"]>()
        .mockResolvedValue(fee);
      const facade = {
        calculateTransactionFee: vi.fn().mockResolvedValue(floor),
        estimateTransactionFee: estimate,
        waitForSyncedState: vi.fn().mockResolvedValue(state),
      } as Partial<funding.WalletFacade> as funding.WalletFacade;
      const expires: number = Date.now() + 120_000;
      await expect(
        ensureTransactionFee(facade, KEYS, "stagenet", TRANSACTION, expires, "startDeposit"),
      ).resolves.toBe(fee);
      expect(estimate).toHaveBeenCalledWith(TRANSACTION, KEYS.dustSecretKey, {
        ttl: new Date(expires),
      });
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it("waits for coin selection to price the balancing fee", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ensure = vi.spyOn(funding, "ensureFeeReady").mockResolvedValue(20n);
    const dust: Partial<funding.FacadeState["dust"]> = { balance: (): bigint => 20n };
    const unshielded: Partial<funding.FacadeState["unshielded"]> = { balances: { NIGHT: 100n } };
    const state = {
      dust: dust as funding.FacadeState["dust"],
      unshielded: unshielded as funding.FacadeState["unshielded"],
    } as funding.FacadeState;
    const estimate = vi
      .fn<funding.WalletFacade["estimateTransactionFee"]>()
      .mockRejectedValueOnce(new Error("could not balance dust"))
      .mockResolvedValue(20n);
    const facade = {
      calculateTransactionFee: vi.fn().mockResolvedValue(10n),
      estimateTransactionFee: estimate,
      waitForSyncedState: vi.fn().mockResolvedValue(state),
    } as Partial<funding.WalletFacade> as funding.WalletFacade;
    const result = ensureTransactionFee(
      facade,
      KEYS,
      "stagenet",
      TRANSACTION,
      Date.now() + 120_000,
      "startDeposit",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toBe(20n);
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("refuses an expired fee preparation window before estimation", async () => {
    const calculate = vi.fn<funding.WalletFacade["calculateTransactionFee"]>();
    const facade = {
      calculateTransactionFee: calculate,
    } as Partial<funding.WalletFacade> as funding.WalletFacade;
    await expect(
      ensureTransactionFee(facade, KEYS, "stagenet", TRANSACTION, Date.now() + 30_000, "withdraw"),
    ).rejects.toThrow("insufficient validity time");
    expect(calculate).not.toHaveBeenCalled();
  });
});

describe("transfer preparation failure", () => {
  it("releases prepared inputs without submitting when fee estimation fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prepared: Awaited<ReturnType<funding.WalletFacade["transferTransaction"]>> = {
      type: "UNPROVEN_TRANSACTION",
      transaction: TRANSACTION,
    };
    const revert = vi.fn<funding.WalletFacade["revert"]>().mockResolvedValue(undefined);
    const submit = vi.fn<funding.WalletFacade["submitTransaction"]>();
    const facade = {
      transferTransaction: vi
        .fn<funding.WalletFacade["transferTransaction"]>()
        .mockResolvedValue(prepared),
      calculateTransactionFee: vi
        .fn<funding.WalletFacade["calculateTransactionFee"]>()
        .mockRejectedValue(new Error("estimator unavailable")),
      revert,
      submitTransaction: submit,
    } as Partial<funding.WalletFacade> as funding.WalletFacade;
    await expect(submitTransferTransaction(facade, KEYS, [], "stagenet")).rejects.toThrow(
      "estimator unavailable",
    );
    expect(revert).toHaveBeenCalledExactlyOnceWith(prepared);
    expect(submit).not.toHaveBeenCalled();
  });
});
