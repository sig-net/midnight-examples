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

/** A vault call proven against the ledger as it was, still unsubmitted. */
export type ProvenCall = Awaited<ReturnType<VaultContext["providers"]["proofProvider"]["proveTx"]>>;

type Transcript = NonNullable<
  Awaited<ReturnType<typeof createUnprovenCallTx>>["public"]["partitionedTranscript"][0]
>;

const GAS_HEADROOM = 2n;
const TTL_MINUTES = 5;

const padGas = (transcript: Transcript | undefined): Transcript | undefined =>
  transcript && {
    ...transcript,
    gas: {
      readTime: transcript.gas.readTime * GAS_HEADROOM,
      computeTime: transcript.gas.computeTime * GAS_HEADROOM,
      bytesWritten: transcript.gas.bytesWritten * GAS_HEADROOM,
      bytesDeleted: transcript.gas.bytesDeleted * GAS_HEADROOM,
    },
  };

/**
 * Proves a vault call against the current ledger with double gas headroom and returns it
 * unsubmitted, so a later ledger change can be landed before it is submitted.
 *
 * @param context - The vault context whose wallet and proof server prove the call.
 * @param circuitId - The vault circuit to call.
 * @param args - The circuit arguments.
 * @returns The proven, unbalanced transaction.
 * @throws {Error} When the vault state or the circuit's verifier key is not on chain.
 */
export async function proveAhead(
  context: VaultContext,
  circuitId: "flush" | "approveRouter",
  args: readonly unknown[],
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
    padGas(guaranteed),
    padGas(fallible),
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
 * Balances and submits a proven call and waits for the node's verdict on it.
 *
 * @param context - The vault context whose wallet pays for the call.
 * @param proven - The call `proveAhead` returned.
 * @returns The finalization status, or the node's refusal when it never entered a block.
 */
export async function submitProven(context: VaultContext, proven: ProvenCall): Promise<string> {
  const balanced = await context.providers.walletProvider.balanceTx(proven);
  let txId: string;
  try {
    txId = await context.providers.midnightProvider.submitTx(balanced);
  } catch (error) {
    return `refused: ${String(error).split("\n")[0] ?? ""}`;
  }
  const data = await context.providers.publicDataProvider.watchForTxData(txId);
  return data.status;
}
