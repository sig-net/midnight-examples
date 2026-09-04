// The split deploy's install order and the resume's verifier-key reads. No
// network: the order is a pure function, and the key reads run against the
// contract package's real compiled output (skipped without `compile:zk` keys,
// visibly, via the describe title).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expectedVk } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { DeferredCircuit } from "@sig-net/midnight-examples-lib";
import { describe, expect, it } from "vitest";

import { orderDeferredCircuits, readDeferredCircuits } from "../src/deploy-vault.ts";
import { VAULT_MANAGED_PATH } from "../src/vault-contract-binding.ts";

const KEYS_DIR = join(VAULT_MANAGED_PATH, "keys");
const HAS_VERIFIER_KEYS = existsSync(KEYS_DIR);

const circuit = (circuitId: string): DeferredCircuit => ({
  circuitId,
  verifierKey: new Uint8Array([circuitId.length]),
});

describe("orderDeferredCircuits", () => {
  interface Case {
    name: string;
    deferred: readonly string[];
    expected: readonly string[];
  }

  const CASES: Case[] = [
    {
      name: "moves initialise to the front and keeps the rest in ledger order",
      deferred: ["refundRedeem", "startWithdraw", "initialise", "startSwap"],
      expected: ["initialise", "refundRedeem", "startWithdraw", "startSwap"],
    },
    {
      name: "leaves an order that already starts with initialise alone",
      deferred: ["initialise", "startSwap"],
      expected: ["initialise", "startSwap"],
    },
    {
      name: "leaves a list without initialise alone",
      deferred: ["startSwap", "refundRedeem"],
      expected: ["startSwap", "refundRedeem"],
    },
    { name: "handles an empty list", deferred: [], expected: [] },
  ];

  it.each(CASES)("$name", ({ deferred, expected }) => {
    expect(orderDeferredCircuits(deferred.map(circuit)).map((c) => c.circuitId)).toEqual(expected);
  });

  it("keeps each circuit's verifier key with its id", () => {
    const ordered = orderDeferredCircuits(["startSwap", "initialise"].map(circuit));
    expect(ordered).toEqual([circuit("initialise"), circuit("startSwap")]);
  });
});

describe.skipIf(!HAS_VERIFIER_KEYS)(
  "readDeferredCircuits (SKIPPED without the contract's src/managed/keys: run `yarn compile:erc20-vault:zk`)",
  () => {
    it("reads every provable circuit's verifier key, matching the generated module's digest", () => {
      const circuitIds = Object.keys(expectedVk);
      expect(circuitIds).toHaveLength(17);
      const deferred = readDeferredCircuits(circuitIds);
      expect(deferred.map((c) => c.circuitId)).toEqual(circuitIds);
      for (const { circuitId, verifierKey } of deferred) {
        expect(verifierKey).toEqual(
          new Uint8Array(readFileSync(join(KEYS_DIR, `${circuitId}.verifier`))),
        );
        expect(createHash("sha256").update(verifierKey).digest("hex")).toBe(expectedVk[circuitId]);
      }
    });

    it("throws on a circuit the compiled output has no key for", () => {
      expect(() => readDeferredCircuits(["noSuchCircuit"])).toThrow(
        /no verifier key for noSuchCircuit/,
      );
    });
  },
);
