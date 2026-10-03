import { readFileSync } from "node:fs";

interface LedgerFieldInfo {
  readonly name: string;
  readonly index: readonly number[];
}

const contractInfo = JSON.parse(
  readFileSync(
    new URL("../src/managed/erc20-vault/compiler/contract-info.json", import.meta.url),
    "utf8",
  ),
) as { readonly ledger: readonly LedgerFieldInfo[] };

/**
 * The ledger-tree path `yarn compile` recorded in contract-info.json for a vault
 * ledger field.
 *
 * @param name - The ledger field's name, as erc20-vault.compact declares it.
 * @returns The field's path: its chunk, then its offset within the chunk.
 * @throws {Error} When contract-info.json records no ledger field of that name.
 */
export const compiledFieldIndex = (name: string): readonly number[] => {
  const field = contractInfo.ledger.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(`contract-info.json records no ledger field named "${name}"`);
  }
  return field.index;
};
