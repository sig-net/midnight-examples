// The split deploy's install order and the resume's verifier-key reads. No
// network: the order is a pure function, and the key reads run against the
// contract package's real compiled output (skipped without `compile:zk` keys,
// visibly, via the describe title).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { computeSha256Hex } from "@midnight-ntwrk/midnight-js/utils";
import * as ledger from "@midnightntwrk/ledger-v9";
import { expectedVk } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { DeferredCircuit, SplitDeployTransaction } from "@sig-net/midnight-examples-lib";
import * as deployBuilders from "@sig-net/midnight-examples-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  estimateVaultDeploymentFee,
  orderDeferredCircuits,
  readDeferredCircuits,
} from "../src/deploy-vault.ts";
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
        expect(computeSha256Hex(verifierKey)).toBe(expectedVk[circuitId]);
      }
    });

    it("throws on a circuit the compiled output has no key for", () => {
      expect(() => readDeferredCircuits(["noSuchCircuit"])).toThrow(
        /no verifier key for noSuchCircuit/,
      );
    });
  },
);

describe("estimateVaultDeploymentFee", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sums unequal fees and binds each insertion to its own maintenance counter", async () => {
    const deploy = new ledger.ContractDeploy(new ledger.ContractState());
    const transaction = ledger.Transaction.fromPartsRandomized(
      "stagenet",
      undefined,
      undefined,
      ledger.Intent.new(new Date(Date.now() + 60_000)).addDeploy(deploy),
    );
    const deployment: SplitDeployTransaction = {
      contractAddress: deploy.address,
      serializedTransaction: transaction.serialize(),
      deferred: [circuit("startSwap"), circuit("initialise")],
    };
    const build = vi
      .spyOn(deployBuilders, "buildMaintenanceInsertTransaction")
      .mockReturnValueOnce({ serializedTransaction: Uint8Array.of(1) })
      .mockReturnValueOnce({ serializedTransaction: Uint8Array.of(2) });
    const estimateFee = vi
      .fn<(bytes: Uint8Array) => Promise<bigint>>()
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(10n)
      .mockResolvedValueOnce(20n);
    const total = await estimateVaultDeploymentFee(deployment, "stagenet", {}, estimateFee);
    expect(total).toBe(130n);
    expect(estimateFee.mock.calls.map(([bytes]) => bytes)).toEqual([
      deployment.serializedTransaction,
      Uint8Array.of(1),
      Uint8Array.of(2),
    ]);
    expect(
      build.mock.calls.map(([, , address, id, , state]) => ({
        address,
        id,
        counter: ledger.ContractState.deserialize(state).maintenanceAuthority.counter,
      })),
    ).toEqual([
      { address: deploy.address, id: "initialise", counter: 0n },
      { address: deploy.address, id: "startSwap", counter: 1n },
    ]);
  });
  it("rejects a transaction without a deployment", async () => {
    const transaction = ledger.Transaction.fromPartsRandomized(
      "stagenet",
      undefined,
      undefined,
      ledger.Intent.new(new Date(Date.now() + 60_000)),
    );
    await expect(
      estimateVaultDeploymentFee(
        {
          contractAddress: "00".repeat(32),
          serializedTransaction: transaction.serialize(),
          deferred: [],
        },
        "stagenet",
        {},
        (): Promise<bigint> => Promise.resolve(100n),
      ),
    ).rejects.toThrow("fee estimation requires a base contract deployment");
  });

  it("prices a deployment with no deferred circuits once", async () => {
    const deploy = new ledger.ContractDeploy(new ledger.ContractState());
    const transaction = ledger.Transaction.fromPartsRandomized(
      "stagenet",
      undefined,
      undefined,
      ledger.Intent.new(new Date(Date.now() + 60_000)).addDeploy(deploy),
    );
    let estimates = 0;
    await expect(
      estimateVaultDeploymentFee(
        {
          contractAddress: deploy.address,
          serializedTransaction: transaction.serialize(),
          deferred: [],
        },
        "stagenet",
        {},
        (): Promise<bigint> => {
          estimates += 1;
          return Promise.resolve(100n);
        },
      ),
    ).resolves.toBe(100n);
    expect(estimates).toBe(1);
  });
});
