// Vault ledger reads: raw contract state from a public data provider, decoded
// with the generated `ledger()`. Takes the provider and address, so a browser
// client, the deploy tooling and a read-only script all drive it the same way.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import { bytesToHex, hexToBytes, toSignBidirectionalEventIndex } from "@sig-net/midnight";

import { ledger } from "./managed/erc20-vault/contract/index.js";

/** The decoded vault public ledger state, as the generated `ledger()` returns it. */
export type VaultLedgerState = ReturnType<typeof ledger>;

/**
 * Read + decode the vault's public ledger state.
 *
 * @param publicDataProvider - The provider to query raw contract state through.
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The decoded ledger state.
 * @throws {Error} If no contract state exists at `vaultContractAddress`.
 */
export async function readVaultLedger(
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
): Promise<VaultLedgerState> {
  const contractState = await publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }
  return ledger(contractState.data);
}

/**
 * Read and print the vault's public ledger state: initialisation status, the
 * configured vault EVM address, the pinned EVM chain, and the pending signet
 * signature requests of the deposit and approve/withdraw maps. No proving keys
 * or transactions involved.
 *
 * @param publicDataProvider - The provider to query raw contract state through.
 * @param vaultContractAddress - The deployed vault contract address, as bare hex.
 * @throws {Error} If `vaultContractAddress` is not hex, or no contract state
 *   exists there.
 */
export async function printVaultState(
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
): Promise<void> {
  // Re-encode the address through bytes before it reaches the log: hexToBytes
  // rejects anything that is not hex, so an env secret misrouted into the
  // address variable is never printed.
  const address = bytesToHex(hexToBytes(vaultContractAddress));
  const state = await readVaultLedger(publicDataProvider, address);
  console.log(`vault contract:    ${address}`);
  console.log(`initialised:       ${String(state.initialised)}`);
  console.log(`vault EVM address: 0x${bytesToHex(state.vaultEvmAddress)}`);
  // caip2Id is zero-padded ASCII; NUL-trim for display.
  console.log(
    `EVM chain:         ${String(state.evmChainId)} (${new TextDecoder().decode(state.caip2Id).replace(/\0+$/u, "")})`,
  );

  printRequestMap("deposit", state.depositEventMap);
  printRequestMap("approve/withdraw", state.signBidirectionalEventMap);
}

/**
 * Print one request map's pending entries under a heading naming the kinds it
 * holds.
 *
 * @param kinds - The request kinds recorded in this map.
 * @param map - The map to enumerate.
 */
function printRequestMap(
  kinds: string,
  map: Parameters<typeof toSignBidirectionalEventIndex>[0],
): void {
  const index = toSignBidirectionalEventIndex(map);
  console.log(`pending ${kinds} signature requests: ${String(index.size)}`);
  for (const [requestIdHex, request] of index) {
    console.log(`- ${requestIdHex} (requestNonce ${String(request.requestNonce)})`);
  }
}

/**
 * The request nonce the vault's `startDeposit` circuit will stamp on the next
 * deposit by `callerCommitment`: this caller's own slot in
 * `depositRequestNonces`, defaulting to 0 when they have never deposited.
 *
 * This is the off-chain twin of the circuit's own nonce read, and it must stay
 * in lockstep with it: the nonce is hashed into the request id, so predicting
 * it wrong makes the recomputed id miss the ledger map key and the whole flow
 * fail. Deposits deliberately do NOT read the shared `signetRequestNonce` --
 * that cell belongs to the vault-path flows (approve/withdraw/swap/supply/
 * redeem). The two agree only on a vault's first-ever deposit, when both read
 * 0, which is exactly how a twin reading the wrong cell passes an e2e suite
 * that never deposits twice as one caller.
 *
 * @param state - The decoded vault ledger state, read before the call.
 * @param callerCommitment - The caller's 32-byte identity commitment.
 * @returns The next request nonce for that caller.
 */
export function depositRequestNonce(state: VaultLedgerState, callerCommitment: Uint8Array): bigint {
  // Absent slot means this caller has never deposited, and the circuit's
  // `insertDefault` seeds it at 0 before reading it, so an absent slot and a
  // slot holding 0 are the same request nonce.
  return state.depositRequestNonces.member(callerCommitment)
    ? state.depositRequestNonces.lookup(callerCommitment).read()
    : 0n;
}

/**
 * The kinds of transaction the VAULT signs with its own derived EVM account.
 * Deposits are absent on purpose: their transaction is signed by the user's
 * own account and carries a caller-supplied envelope.
 */
export type VaultGasKind = "withdraw" | "approve" | "swap" | "supply" | "redeem";

/** The EIP-1559 gas envelope of one vault-signed transaction. */
export interface VaultGasEnvelope {
  /** Gas limit for this kind of operation. */
  readonly gasLimit: bigint;
  /** Fee ceiling, shared by every kind. */
  readonly maxFeePerGas: bigint;
  /** Miner tip, shared by every kind. */
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * The gas envelope the vault's circuits will stamp on a `kind` transaction,
 * read from the ledger the deployer's `setGasParams` writes.
 *
 * This is the off-chain twin of the circuits' own reads, and it must stay in
 * lockstep with them: the envelope is hashed into the request id, so a stale
 * value makes the recomputed id miss the ledger map key and the flow fail.
 * It is read rather than mirrored as a constant precisely because these
 * values move -- `maxFeePerGas` is a ceiling that has to be raised when the
 * base fee climbs, and a constant would be right only until the first
 * `setGasParams` call.
 *
 * @param state - The decoded vault ledger state, read before the call.
 * @param kind - The vault-signed operation whose gas limit applies.
 * @returns The gas limit for that kind plus the global fee ceiling and tip.
 */
export function vaultGasEnvelope(state: VaultLedgerState, kind: VaultGasKind): VaultGasEnvelope {
  const gasLimits: Record<VaultGasKind, bigint> = {
    withdraw: state.vaultWithdrawGasLimit,
    approve: state.vaultApproveGasLimit,
    swap: state.vaultSwapGasLimit,
    supply: state.vaultSupplyGasLimit,
    redeem: state.vaultRedeemGasLimit,
  };
  return {
    gasLimit: gasLimits[kind],
    maxFeePerGas: state.vaultMaxFeePerGas,
    maxPriorityFeePerGas: state.vaultMaxPriorityFeePerGas,
  };
}
