// The CONTRACT-FIXED MPC routing of every vault SignBidirectionalEvent, needed to
// rebuild expected event records off-chain: TS mirrors of the vault contract's
// in-circuit constants, which MUST stay in lockstep with erc20-vault.compact, and
// each action's output schema read from its compiled pure circuit. The vault
// contract package's round-trip simulator tests assert the same values against
// the real compiled contract.

import {
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  pureCircuits,
} from "@sig-net/midnight";
import { pureCircuits as vaultCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

import { schemaJson } from "./schema-json.ts";

/** The ABI output schema of the vault's ERC20 transfer and approve requests, as JSON text. */
export const ERC20_TRANSFER_OUTPUT_SCHEMA = schemaJson(vaultCircuits.vaultOutputSchema());

/** The empty ABI output schema of a nonce replacement (a plain transfer returns nothing), as JSON text. */
export const REPLACE_NONCE_OUTPUT_SCHEMA = schemaJson(vaultCircuits.replaceNonceOutputSchema());

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
  /** MPC output_deserialization_schema at its contract-declared width: the attested bytes derive from it. */
  readonly outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema: reserved, pinned to `Bytes<0>` by `constructSignBidirectionalEventV1`. */
  readonly respondSerializationSchema: Uint8Array;
}

/**
 * The routing the vault contract bakes into every deposit, withdraw and approve
 * event it records: ECDSA, an unused signature destination, no extras, the MPC's
 * Ethereum routing key as the execution destination, and the contract-declared
 * single-bool ABI output schema.
 */
export const TRANSFER_RESULT_MPC_ROUTING: VaultMpcRouting = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: pureCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: vaultCircuits.vaultOutputSchema(),
  respondSerializationSchema: new Uint8Array(0),
};

/**
 * The routing of a nonce replacement event: {@link TRANSFER_RESULT_MPC_ROUTING}'s
 * fields with the empty output schema, since a plain transfer returns nothing and
 * the MPC attests its execution over the empty output.
 */
export const REPLACE_NONCE_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.replaceNonceOutputSchema(),
};

/**
 * The routing of a swap event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields with
 * the swap's own output schema, which decodes `exactOutputSingle`'s uint256
 * `amountIn`, attested whole as 32 little-endian bytes.
 */
export const SWAP_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.swapOutputSchema(),
};

/**
 * The routing of a supply event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields
 * with the supply's own output schema, which decodes the wrapper `deposit`'s
 * uint256 shares, attested whole as 32 little-endian bytes.
 */
export const SUPPLY_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.supplyOutputSchema(),
};

/**
 * The routing of a redeem event: {@link TRANSFER_RESULT_MPC_ROUTING}'s fields
 * with the redeem's own output schema, which decodes the wrapper `redeem`'s
 * uint256 assets, attested whole as 32 little-endian bytes.
 */
export const REDEEM_MPC_ROUTING: VaultMpcRouting = {
  ...TRANSFER_RESULT_MPC_ROUTING,
  outputDeserializationSchema: vaultCircuits.redeemOutputSchema(),
};
