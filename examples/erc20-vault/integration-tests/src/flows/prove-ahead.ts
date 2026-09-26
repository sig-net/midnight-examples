import { createCallTxOptions, createUnprovenCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import { getNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { encodeContractKeyLocation, hashVerifierKey } from "@midnight-ntwrk/midnight-js/types";
import {
  communicationCommitmentRandomness,
  ContractCallPrototype,
  ContractState,
  Intent,
  Transaction as LedgerTransaction,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { VAULT_PRIVATE_STATE_ID } from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/** An unsubmitted vault call with completed contract proofs. */
export type ProvenCall = Awaited<ReturnType<VaultContext["providers"]["proofProvider"]["proveTx"]>>;

type Transcript = NonNullable<
  Awaited<ReturnType<typeof createUnprovenCallTx>>["public"]["partitionedTranscript"][0]
>;

const TTL_MINUTES = 5;
const SUBMIT_ATTEMPTS = 3;
const SUBMIT_RETRY_MS = 10_000;

const padGas = (
  transcript: Transcript | undefined,
  byteCostMultiplier: bigint,
  computeTimePercentage: bigint,
): Transcript | undefined =>
  transcript && {
    ...transcript,
    gas: {
      ...transcript.gas,
      computeTime: (transcript.gas.computeTime * computeTimePercentage + 99n) / 100n,
      bytesWritten: transcript.gas.bytesWritten * byteCostMultiplier,
      bytesDeleted: transcript.gas.bytesDeleted * byteCostMultiplier,
    },
  };

/**
 * Proves a vault call against the current ledger and returns it unsubmitted, so a later ledger
 * change can be landed before it is submitted. Byte and compute costs allow for map growth.
 * Compute headroom is opt-in because declared time contributes to the transaction-size limit.
 *
 * @param context - The vault context whose wallet and proof server prove the call.
 * @param circuitId - The vault circuit to call.
 * @param args - The circuit arguments.
 * @param byteCostMultiplier - Headroom for written and deleted bytes, doubled by default.
 * @param computeTimePercentage - Compute budget as a percentage of the measured allowance, 100 by default.
 * @returns The proven, unbalanced transaction.
 * @throws {Error} When the vault state or the circuit's verifier key is not on chain.
 */
export async function proveAhead(
  context: VaultContext,
  circuitId: "flush" | "approveRouter",
  args: readonly unknown[],
  byteCostMultiplier = 2n,
  computeTimePercentage = 100n,
): Promise<ProvenCall> {
  const options = createCallTxOptions(
    vaultCompiledContract,
    circuitId,
    context.vaultContractAddress,
    VAULT_PRIVATE_STATE_ID,
    undefined,
    args as never,
  );
  const call = await createUnprovenCallTx(context.providers, {
    ...options,
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  const raw = await context.providers.publicDataProvider.queryContractState(
    context.vaultContractAddress,
  );
  if (!raw) throw new Error("vault contract state not found");
  const state = raw instanceof ContractState ? raw : ContractState.deserialize(raw.serialize());
  const operation = state.operation(circuitId);
  if (!operation?.verifierKey) throw new Error(`${circuitId} has no verifier key on chain`);
  const [guaranteed, fallible] = call.public.partitionedTranscript;
  const prototype = new ContractCallPrototype(
    context.vaultContractAddress,
    circuitId,
    operation,
    padGas(guaranteed, byteCostMultiplier, computeTimePercentage),
    padGas(fallible, byteCostMultiplier, computeTimePercentage),
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationCommitmentRandomness(),
    encodeContractKeyLocation({
      contractAddress: context.vaultContractAddress,
      circuitId,
      verifierKeyHash: hashVerifierKey(operation.verifierKey),
    }),
  );
  const intent = Intent.new(new Date(Date.now() + TTL_MINUTES * 60_000)).addCall(prototype);
  const unproven = LedgerTransaction.fromPartsRandomized(
    getNetworkId(),
    undefined,
    undefined,
    intent,
  );
  return context.providers.proofProvider.proveTx(unproven);
}

/**
 * Balances and submits a proven call and waits for the node's verdict on it. A submission the
 * node refuses is re-balanced and retried, so a wallet that has not caught up with its last
 * transaction cannot fail the call by itself.
 *
 * @param context - The vault context whose wallet pays for the call.
 * @param proven - The call `proveAhead` returned.
 * @returns The finalization status, or the node's refusal when it never entered a block.
 */
export async function submitProven(context: VaultContext, proven: ProvenCall): Promise<string> {
  let refusal = "";
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SUBMIT_RETRY_MS));
    const balanced = await context.providers.walletProvider.balanceTx(proven);
    let txId: string;
    try {
      txId = await context.providers.midnightProvider.submitTx(balanced);
    } catch (error) {
      refusal = `refused: ${String(error).split("\n")[0] ?? ""}`;
      continue;
    }
    const data = await context.providers.publicDataProvider.watchForTxData(txId);
    return data.status;
  }
  return refusal;
}
