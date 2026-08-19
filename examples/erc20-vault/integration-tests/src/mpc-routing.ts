// The CONTRACT-FIXED MPC routing of every vault SignBidirectionalEvent: the
// TS mirror of the vault contract's in-circuit constants, needed to rebuild
// expected event records off-chain. MUST stay in lockstep with
// erc20-vault.compact; the vault contract package's round-trip simulator
// tests assert the same values against the real compiled contract.

import {
  asciiPadded,
  bytesToHex,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  PATH_BYTES,
} from "@sig-net/midnight";

/**
 * The vault's own derivation path as the ledger stores it: the withdraw
 * circuit sets every record's `path` to `pad(32, "vault")`.
 */
export const VAULT_PATH_BYTES = asciiPadded("vault", PATH_BYTES);

/**
 * The derivation-string rendering of {@link VAULT_PATH_BYTES}: the MPC
 * renders a record's path as the lowercase hex of the full 32 bytes,
 * padding included, and `deriveEvmAddress` takes the same rendering.
 */
export const VAULT_PATH_HEX = bytesToHex(VAULT_PATH_BYTES);

/**
 * What the MPC reports back about the EVM call: an ERC20 `transfer` returns
 * a single bool. Serves as both the output-deserialization and the
 * respond-serialization schema of the vault's events. Stored at its EXACT
 * byte width (schemas are exact-width by protocol convention, never
 * zero-padded: off-chain readers recover the declared width from the stored
 * bytes).
 */
export const ERC20_TRANSFER_RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';

/** The contract-declared byte width of the vault's schemas (Compact `Bytes<34>`). */
export const VAULT_SCHEMA_BYTES = ERC20_TRANSFER_RESULT_SCHEMA.length;

/**
 * The contract-fixed routing fields of a vault event. Field names match
 * `SignBidirectionalEvent`, so an expected event record can spread a value
 * of this type directly.
 */
export interface VaultMpcRouting {
  /** Signature algorithm: an `MPCSignatureAlgorithm` variant index (ecdsa). */
  readonly algo: number;
  /** Destination field: an `MPCDestination` variant index (unused). */
  readonly dest: number;
  /** Extra MPC parameters (reserved, zeroed); 64 bytes. */
  readonly params: Uint8Array;
  /** MPC output_deserialization_schema at its declared 34-byte width. */
  readonly outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema at its declared 34-byte width. */
  readonly respondSerializationSchema: Uint8Array;
}

/**
 * The routing the vault contract bakes into every event it records: ECDSA,
 * an unused destination field, no extras, and the ERC20 `transfer` bool
 * result schema in both directions.
 */
export const VAULT_MPC_ROUTING: VaultMpcRouting = {
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, VAULT_SCHEMA_BYTES),
  respondSerializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, VAULT_SCHEMA_BYTES),
};
