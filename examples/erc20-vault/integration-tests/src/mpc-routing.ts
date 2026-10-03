// The CONTRACT-FIXED MPC routing of every vault SignBidirectionalEvent, needed to
// rebuild expected event records off-chain: TS mirrors of the vault contract's
// in-circuit constants, which MUST stay in lockstep with erc20-vault.compact, and
// the swap's, the supply's and the redeem's schemas read from its compiled pure
// circuits. The vault contract package's round-trip simulator tests assert the
// same values against the real compiled contract.

import {
  asciiPadded,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  pureCircuits,
} from "@sig-net/midnight";
import { pureCircuits as vaultCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

/**
 * What the MPC reports back about an ERC20 `transfer` or `approve`, and about a
 * plain transfer: a single bool. Serves as both the output-deserialization and
 * the respond-serialization schema of every vault event except a swap's, a
 * supply's and a redeem's. Stored at its EXACT byte width (schemas are
 * exact-width by protocol convention, never zero-padded: off-chain readers
 * recover the declared width from the stored bytes).
 */
export const ERC20_TRANSFER_RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';

/** The contract-declared byte width of {@link ERC20_TRANSFER_RESULT_SCHEMA} (Compact `Bytes<34>`). */
export const ERC20_TRANSFER_RESULT_SCHEMA_BYTES = ERC20_TRANSFER_RESULT_SCHEMA.length;

/**
 * The contract-fixed routing fields of a vault event. Field names match
 * `SignBidirectionalEvent`, so an expected event record can spread a value
 * of this type directly.
 */
export interface VaultMpcRouting {
  /** Signature algorithm: an `MPCSignatureAlgorithm` variant index (ecdsa). */
  readonly algo: number;
  /** Execution destination: the MPC's Ethereum routing key (`ethereumCaip2Id()`), zero-padded to 32 bytes. */
  readonly executionDest: Uint8Array;
  /** Signature destination: an `MPCDestination` variant index (unused, reserved). */
  readonly signatureDest: number;
  /** Extra MPC parameters (reserved, zeroed); 64 bytes. */
  readonly params: Uint8Array;
  /** MPC output_deserialization_schema at its contract-declared width. */
  readonly outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema at its contract-declared width. */
  readonly respondSerializationSchema: Uint8Array;
}

/**
 * The routing the vault contract bakes into every event it records except a
 * swap's, a supply's and a redeem's: ECDSA, an unused signature destination,
 * no extras, the MPC's Ethereum routing key as the execution destination, and
 * {@link ERC20_TRANSFER_RESULT_SCHEMA} in both directions.
 */
export const TRANSFER_RESULT_MPC_ROUTING: VaultMpcRouting = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: pureCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(
    ERC20_TRANSFER_RESULT_SCHEMA,
    ERC20_TRANSFER_RESULT_SCHEMA_BYTES,
  ),
  respondSerializationSchema: asciiPadded(
    ERC20_TRANSFER_RESULT_SCHEMA,
    ERC20_TRANSFER_RESULT_SCHEMA_BYTES,
  ),
};

/**
 * The routing of a swap event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields with
 * the swap's own schemas, which decode `exactOutputSingle`'s uint256 `amountIn`
 * and pack it as a uint64.
 */
export const SWAP_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.swapOutputSchema(),
  respondSerializationSchema: vaultCircuits.swapRespondSchema(),
};

/**
 * The routing of a supply event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields
 * with the supply's own schemas, which decode the wrapper `deposit`'s uint256
 * shares and pack them as a uint64.
 */
export const SUPPLY_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.supplyOutputSchema(),
  respondSerializationSchema: vaultCircuits.supplyRespondSchema(),
};

/**
 * The routing of a redeem event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields
 * with the redeem's own schemas, which decode the wrapper `redeem`'s uint256
 * assets and pack them as a uint64.
 */
export const REDEEM_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.redeemOutputSchema(),
  respondSerializationSchema: vaultCircuits.redeemRespondSchema(),
};
