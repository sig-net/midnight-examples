// Offline unit tests for `depositRequestNonce`, the off-chain twin of the
// nonce read inside the `startDeposit` circuit.
//
// The nonce is hashed into the request id, so the twin has to agree with the
// circuit on every call, not just the first. The circuit takes the nonce from
// THIS caller's slot in `depositRequestNonces` (defaulting to 0 when the
// caller has never deposited) and leaves the shared `signetRequestNonce`
// alone. A twin that reads `signetRequestNonce` instead agrees by accident on
// a vault's very first deposit — both cells read 0 — and diverges on every
// deposit after that. That accident is why the bug survived the e2e suite:
// no flow ever deposited twice as the same caller.
//
// The helper lives beside `readVaultLedger` in the contract package's
// ledger reads, so these are offline in-process unit tests of that package:
// a ledger-state stub, no network, no docker, no provider.

import { describe, expect, it } from "vitest";

import { depositRequestNonce, type VaultLedgerState } from "../src/vault-ledger.ts";

const commitment = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const ALICE = commitment(0xa1);
const BOB = commitment(0xb0);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A vault ledger state carrying only what `depositRequestNonce` reads: the
 * per-caller counters and the shared nonce. The `depositRequestNonces` stub
 * mirrors the generated ledger's map surface (`member` / `lookup(...).read()`)
 * so the helper is exercised through the same calls it makes in production.
 *
 * @param options - The two cells under test.
 * @param options.depositNonces - Per-caller counters, keyed by commitment hex.
 * @param options.signetRequestNonce - The shared vault-path nonce.
 * @returns A ledger state stub typed as the real decoded state.
 */
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
          // The real ledger map throws on a missing key, so the stub must too:
          // a helper that looks up before checking `member` has to fail here.
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
    // The case no existing test covered. After one deposit the circuit has
    // incremented Alice's slot to 1, so the next request id hashes nonce 1.
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 1n } });

    expect(depositRequestNonce(state, ALICE)).toBe(1n);
  });

  it("keeps counting up across repeat deposits by the same caller", () => {
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 7n } });

    expect(depositRequestNonce(state, ALICE)).toBe(7n);
  });

  it("reads the caller's OWN slot, not another caller's", () => {
    // Two callers deposit independently; each slot advances on its own.
    const state = ledgerState({ depositNonces: { [hex(ALICE)]: 3n, [hex(BOB)]: 1n } });

    expect(depositRequestNonce(state, ALICE)).toBe(3n);
    expect(depositRequestNonce(state, BOB)).toBe(1n);
  });

  it("ignores the shared signetRequestNonce entirely", () => {
    // The vault-path flows (approve/withdraw/swap/supply/redeem) drive
    // signetRequestNonce; deposits must not read it. Both cells are set to
    // values that differ from each other AND from 0, so a twin reading the
    // wrong one cannot pass by coincidence.
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
