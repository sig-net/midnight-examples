import { describe, expect, it } from "vitest";

import { depositRequestNonce, type VaultLedgerState } from "../src/vault-ledger.ts";

const commitment = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const ALICE = commitment(0xa1);
const BOB = commitment(0xb0);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const ledgerState = ({
  depositNonces = {},
  signetRequestNonce = 0n,
}: {
  readonly depositNonces?: Readonly<Record<string, bigint>>;
  readonly signetRequestNonce?: bigint;
}): VaultLedgerState =>
  ({
    signetRequestNonce,
    depositRequestNonces: {
      member: (key: Uint8Array) => hex(key) in depositNonces,
      lookup: (key: Uint8Array) => {
        const value = depositNonces[hex(key)];
        if (value === undefined) {
          throw new Error(`no depositRequestNonces entry for ${hex(key)}`);
        }
        return { read: () => value };
      },
    },
  }) as unknown as VaultLedgerState;

describe("depositRequestNonce", () => {
  it("is 0 for a caller's FIRST deposit (no slot yet)", () => {
    const state = ledgerState({ depositNonces: {} });

    expect(depositRequestNonce(state, ALICE)).toBe(0n);
  });

  it("is the caller's own count on their SECOND deposit", () => {
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 1n } });

    expect(depositRequestNonce(state, ALICE)).toBe(1n);
  });

  it("keeps counting up across repeat deposits by the same caller", () => {
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 7n } });

    expect(depositRequestNonce(state, ALICE)).toBe(7n);
  });

  it("reads the caller's OWN slot, not another caller's", () => {
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 3n, [hex(BOB)]: 1n } });

    expect(depositRequestNonce(state, ALICE)).toBe(3n);
    expect(depositRequestNonce(state, BOB)).toBe(1n);
  });

  it("ignores the shared signetRequestNonce entirely", () => {
    const state = ledgerState({
      depositNonces: { [hex(ALICE)]: 2n },
      signetRequestNonce: 9n,
    });

    expect(depositRequestNonce(state, ALICE)).toBe(2n);
  });

  it("is 0 for a caller with no slot even when other callers have deposited", () => {
    const state = ledgerState({
      depositNonces: { [hex(BOB)]: 4n },
      signetRequestNonce: 4n,
    });

    expect(depositRequestNonce(state, ALICE)).toBe(0n);
  });
});
