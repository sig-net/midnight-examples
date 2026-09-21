import { describe, expect, it } from "vitest";

import { vaultGasEnvelope, type VaultLedgerState } from "../src/vault-ledger.ts";

const STORED = {
  vaultMaxFeePerGas: 150_000_000_000n,
  vaultMaxPriorityFeePerGas: 1_000_000_000n,
  vaultGasLimits: {
    withdraw: 100_000n,
    approve: 122_000n,
    swap: 700_000n,
    supply: 500_000n,
    redeem: 555_000n,
  },
};

const ledgerState = (overrides: Partial<typeof STORED> = {}): VaultLedgerState =>
  ({ ...STORED, ...overrides }) as unknown as VaultLedgerState;

describe("vaultGasEnvelope", () => {
  it.each([
    ["withdraw", STORED.vaultGasLimits.withdraw],
    ["approve", STORED.vaultGasLimits.approve],
    ["swap", STORED.vaultGasLimits.swap],
    ["supply", STORED.vaultGasLimits.supply],
    ["redeem", STORED.vaultGasLimits.redeem],
  ] as const)("reads the %s gas limit", (kind, gasLimit) => {
    expect(vaultGasEnvelope(ledgerState(), kind)).toEqual({
      gasLimit,
      maxFeePerGas: STORED.vaultMaxFeePerGas,
      maxPriorityFeePerGas: STORED.vaultMaxPriorityFeePerGas,
    });
  });

  it("gives the five kinds five different gas limits", () => {
    const state = ledgerState();
    const limits = (["withdraw", "approve", "swap", "supply", "redeem"] as const).map(
      (kind) => vaultGasEnvelope(state, kind).gasLimit,
    );

    expect(limits).toEqual([100_000n, 122_000n, 700_000n, 500_000n, 555_000n]);
  });

  it("shares ONE fee ceiling and tip across every kind", () => {
    const state = ledgerState();
    const fees = (["withdraw", "approve", "swap", "supply", "redeem"] as const).map((kind) => {
      const { maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(state, kind);
      return `${String(maxFeePerGas)}/${String(maxPriorityFeePerGas)}`;
    });

    expect(new Set(fees).size).toBe(1);
  });

  it("follows the ledger after the deployer raises the cap", () => {
    const raised = ledgerState({ vaultMaxFeePerGas: 900_000_000_000n });

    expect(vaultGasEnvelope(raised, "swap").maxFeePerGas).toBe(900_000_000_000n);
  });
});
