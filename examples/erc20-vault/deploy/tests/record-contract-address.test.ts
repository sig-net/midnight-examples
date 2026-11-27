// Unit tests for the vault-addresses.ts table surgery behind the
// record-contract-address entrypoint: the network gate, the row rewrite, and
// its lockstep with the real vault-addresses.ts source.

import { readFileSync } from "node:fs";

import { contractAddressFromHex, type DeployedNetwork, MidnightNetwork } from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import {
  parseDeployedNetwork,
  recordContractAddress,
  VAULT_ADDRESSES_PATH,
} from "../src/record-contract-address.ts";

const ADDRESS_HEX = "1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d";
const ADDRESS = contractAddressFromHex(ADDRESS_HEX);
const EXISTING_HEX = "ab".repeat(32);
// Recorded into the real vault-addresses.ts below, so it must be one no
// network's row can already hold: a pattern no deploy produces.
const UNRECORDED_HEX = "5e".repeat(32);
const UNRECORDED = contractAddressFromHex(UNRECORDED_HEX);

describe("parseDeployedNetwork", () => {
  it.each([
    ["preview", MidnightNetwork.Preview],
    ["preprod", MidnightNetwork.Preprod],
    ["mainnet", MidnightNetwork.Mainnet],
  ])("accepts %s", (networkId, expected) => {
    expect(parseDeployedNetwork(networkId)).toBe(expected);
  });

  it.each([
    ["the local standalone stack", "undeployed"],
    ["an unknown id", "nope"],
    ["a member name instead of an id", "Preview"],
  ])("rejects %s", (_name, networkId) => {
    expect(() => parseDeployedNetwork(networkId)).toThrow(
      /expected one of preview, preprod, mainnet/,
    );
  });
});

describe("recordContractAddress", () => {
  // A cut-down vault-addresses.ts: the import line, then the address table
  // with one row already filled.
  const PREAMBLE = `import { type DeployedNetwork, MidnightNetwork } from "@sig-net/midnight";
`;
  const ADDRESS_TABLE = `const vaultContractAddresses: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "${EXISTING_HEX}",
  [MidnightNetwork.Mainnet]: "",
};
`;
  const SOURCE = PREAMBLE + "\n" + ADDRESS_TABLE;

  interface Case {
    name: string;
    network: MidnightNetwork.Preview | MidnightNetwork.Preprod;
    previousEntry: string;
    entry: string;
  }

  const CASES: Case[] = [
    {
      name: "fills an empty row",
      network: MidnightNetwork.Preview,
      previousEntry: '[MidnightNetwork.Preview]: ""',
      entry: `[MidnightNetwork.Preview]: "${ADDRESS_HEX}"`,
    },
    {
      name: "replaces a filled row",
      network: MidnightNetwork.Preprod,
      previousEntry: `[MidnightNetwork.Preprod]: "${EXISTING_HEX}"`,
      entry: `[MidnightNetwork.Preprod]: "${ADDRESS_HEX}"`,
    },
  ];

  it.each(CASES)("$name, touching nothing else", ({ network, previousEntry, entry }) => {
    const recorded = recordContractAddress(SOURCE, network, ADDRESS);
    expect(recorded.previousEntry).toBe(previousEntry);
    expect(recorded.entry).toBe(entry);
    expect(recorded.source).toBe(PREAMBLE + "\n" + ADDRESS_TABLE.replace(previousEntry, entry));
  });

  it("normalises a 0x-prefixed uppercase address to bare lowercase hex", () => {
    const address = contractAddressFromHex(`0x${ADDRESS_HEX.toUpperCase()}`);
    expect(recordContractAddress(SOURCE, MidnightNetwork.Preview, address).entry).toBe(
      `[MidnightNetwork.Preview]: "${ADDRESS_HEX}"`,
    );
  });

  interface ThrowCase {
    name: string;
    source: string;
    expectedMessage: RegExp;
  }

  const THROW_CASES: ThrowCase[] = [
    {
      name: "no address table",
      source: PREAMBLE,
      expectedMessage: /no "vaultContractAddresses" table/,
    },
    {
      name: "an unclosed address table",
      source: PREAMBLE + "\n" + ADDRESS_TABLE.replace("\n};", ""),
      expectedMessage: /not closed/,
    },
    {
      name: "a table without the network's row",
      source: PREAMBLE + "\n" + ADDRESS_TABLE.replace('[MidnightNetwork.Preview]: "",\n', ""),
      expectedMessage: /expected exactly one preview row in vaultContractAddresses, found 0/,
    },
    {
      name: "a table with the network's row twice",
      source: PREAMBLE + "\n" + ADDRESS_TABLE.replace('""', '"",\n  [MidnightNetwork.Preview]: ""'),
      expectedMessage: /expected exactly one preview row in vaultContractAddresses, found 2/,
    },
  ];

  it.each(THROW_CASES)("throws on $name", ({ source, expectedMessage }) => {
    expect(() => recordContractAddress(source, MidnightNetwork.Preview, ADDRESS)).toThrow(
      expectedMessage,
    );
  });

  // Lockstep with the file the entrypoint edits: the fixture above mirrors its
  // shape, and this pins the real source to the same shape.
  it("rewrites every deployed network's row of the real vault-addresses.ts", () => {
    const real = readFileSync(VAULT_ADDRESSES_PATH, "utf8");
    expect(real).not.toContain(UNRECORDED_HEX);
    const networks: DeployedNetwork[] = [
      MidnightNetwork.Preview,
      MidnightNetwork.Preprod,
      MidnightNetwork.Mainnet,
    ];
    for (const network of networks) {
      const recorded = recordContractAddress(real, network, UNRECORDED);
      expect(recorded.source).toContain(recorded.entry);
      expect(recorded.source.split(UNRECORDED_HEX)).toHaveLength(2);
    }
  });
});
