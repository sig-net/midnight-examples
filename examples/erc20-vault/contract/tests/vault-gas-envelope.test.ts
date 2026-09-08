// Offline unit tests for `vaultGasEnvelope`, the off-chain twin of the gas
// envelope the vault stamps on the transactions it signs itself.
//
// The envelope is hashed into the request id, so the twin has to agree with
// the circuit cell for cell. It used to be a TS constant per flow
// (SWAP_MAX_FEE_PER_GAS and friends) mirroring a literal in the contract;
// now that the contract reads ledger values a deployer can move, a constant
// would be right only until the first setGasParams call and wrong forever
// after. That is the same failure mode as the deposit request nonce: a twin
// that agrees by coincidence until some state moves.
//
// The helper lives beside `readVaultLedger` in the contract package's ledger
// reads, so these are offline in-process unit tests of that package: a
// ledger-state stub, no network, no docker, no provider.

import { describe, expect, it } from "vitest";

import { vaultGasEnvelope, type VaultLedgerState } from "../src/vault-ledger.ts";

// Seven values, all distinct, none equal to any other: a lookup that reads
// the wrong cell cannot pass by coincidence.
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
    // The cap and tip track the market, not the operation, so they are global
    // ledger values; only the gas limit is per kind.
    const state = ledgerState();
    const fees = (["withdraw", "approve", "swap", "supply", "redeem"] as const).map((kind) => {
      const { maxFeePerGas, maxPriorityFeePerGas } = vaultGasEnvelope(state, kind);
      return `${String(maxFeePerGas)}/${String(maxPriorityFeePerGas)}`;
    });

    expect(new Set(fees).size).toBe(1);
  });

  it("follows the ledger after the deployer raises the cap", () => {
    // The whole point: setGasParams moves the cell, and the twin moves with
    // it. A hardcoded constant would still predict the old ceiling here and
    // recompute every vault-signed request id wrong.
    const raised = ledgerState({ vaultMaxFeePerGas: 900_000_000_000n });

    expect(vaultGasEnvelope(raised, "swap").maxFeePerGas).toBe(900_000_000_000n);
  });
});
