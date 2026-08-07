// Seed parsing — turns user input (a BIP-39 mnemonic or a raw hex seed) into
// the seed bytes the HD wallet derives from, plus a record of how it was
// supplied (so the normalised hex form can be used as a stable identifier).
import * as bip39 from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Decode hex digits that a caller has ALREADY validated as even-length and
// hex-only; a bad digit would decode to NaN rather than throwing.
const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/** How the input seed was supplied. */
export enum SeedFormat {
  Mnemonic = "mnemonic",
  Hex = "hex",
}

/** Where a parsed seed came from, including its normalised hex form. */
export interface DerivationSource {
  format: SeedFormat;
  /** Word count, when the input was a mnemonic. */
  words?: number;
  /** The normalised hex of the seed bytes — the stable dedup key. */
  seedHex: string;
  seedBytes: number;
}

/** Thrown when a seed or identity secret fails to parse — see {@link parseSeed} and {@link identitySecretFromSeed}. */
export class ParseError extends Error {}

/**
 * Parse `input` as a hex seed (16–64 bytes, optional 0x prefix) or a BIP-39
 * mnemonic (run through PBKDF2 to its 64-byte seed).
 *
 * @param input - The seed as supplied by the user: hex or mnemonic.
 * @returns The seed bytes plus a {@link DerivationSource} record of how they were supplied.
 * @throws {ParseError} When the input is neither valid hex nor a valid mnemonic.
 */
export function parseSeed(input: string): { seed: Uint8Array; source: DerivationSource } {
  const trimmed = input.trim();
  if (!trimmed) throw new ParseError("Nothing to parse — generate or paste a seed first.");

  const compact = trimmed.replace(/^0x/i, "");
  const looksHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0;

  if (looksHex) {
    const bytes = compact.length / 2;
    if (bytes < 16 || bytes > 64) {
      throw new ParseError(`Hex seed must be 16–64 bytes; got ${String(bytes)}.`);
    }
    const seed = fromHex(compact);
    return {
      seed,
      source: { format: SeedFormat.Hex, seedHex: compact.toLowerCase(), seedBytes: bytes },
    };
  }

  const words = trimmed.split(/\s+/);
  if (!bip39.validateMnemonic(words.join(" "), english)) {
    throw new ParseError("Not a valid BIP-39 mnemonic (and not valid hex).");
  }
  const seed = bip39.mnemonicToSeedSync(words.join(" "));
  return {
    seed,
    source: {
      format: SeedFormat.Mnemonic,
      words: words.length,
      seedHex: toHex(seed),
      seedBytes: seed.length,
    },
  };
}

/**
 * A wallet seed's 32 bytes as an identity secret: the private preimage whose
 * commitment (the hash the vault's `userCommitment` circuit computes) is the
 * caller's on-ledger identity. The wallet that spends and the identity that
 * gates a circuit share one seed by construction here, matching how the
 * example's wallets are generated.
 *
 * @param seed - The wallet seed, as hex (16-64 bytes, optional 0x prefix) or
 *   a BIP-39 mnemonic.
 * @returns The 32-byte identity secret.
 * @throws {ParseError} When the seed does not parse, or parses to anything
 *   other than exactly 32 bytes (a mnemonic always does: it expands to 64,
 *   so identity-bearing wallets need a 32-byte hex seed).
 */
export function identitySecretFromSeed(seed: string): Uint8Array {
  const { seed: bytes } = parseSeed(seed);
  if (bytes.length !== 32) {
    throw new ParseError(
      `The seed parses to ${String(bytes.length)} bytes; an identity secret needs exactly 32. ` +
        `Use a 32-byte hex seed for identity-bearing wallets.`,
    );
  }
  return bytes;
}
