import {
  broadcastTronTransaction,
  bytesToHex,
  getSolidifiedTronTransactionInfo,
  TronBroadcastOutcome,
  type TronTransactionInfo,
} from "@sig-net/midnight";

import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import type { TronContext } from "../tron-context.ts";

/** The signed transaction {@link broadcastTron} sends and how long it waits. */
export interface BroadcastTronOptions {
  readonly signedTransaction: Uint8Array;
  readonly txid: Uint8Array;
  readonly timeoutMs: number;
}

/** The final receipt, and whether the transaction was final before this call. */
export interface BroadcastTronResult extends TronTransactionInfo {
  readonly alreadyLanded: boolean;
}

async function waitForSolidifiedReceipt(
  rpcUrl: string,
  txid: Uint8Array,
  timeoutMs: number,
): Promise<TronTransactionInfo> {
  const progress = new PollProgress(`Tron receipt ${bytesToHex(txid)}`, timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const receipt = await getSolidifiedTronTransactionInfo(rpcUrl, txid);
      if (receipt !== undefined) return receipt;
      progress.update("not in a solidified block yet");
      await sleepUnlessAborted(1_000, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Broadcasts a signed request transaction and waits for its final (solidified) receipt, the
 * one the MPC attests from. Anyone may broadcast the bytes once the MPC posts the signature,
 * so a node that already holds them is not an error.
 *
 * @param tron - The Tron context
 * @param options - The transaction and how long to wait
 * @returns The final receipt, and whether it was final before this call
 * @throws {Error} If the node refuses the transaction (for example once it expired) or no
 *   receipt solidifies in time
 */
export async function broadcastTron(
  tron: TronContext,
  options: BroadcastTronOptions,
): Promise<BroadcastTronResult> {
  const txidHex = bytesToHex(options.txid);
  const landed = await getSolidifiedTronTransactionInfo(tron.tronRpcUrl, options.txid);
  if (landed !== undefined) {
    console.log(`Tron transaction ${txidHex} already in block ${String(landed.blockNumber)}`);
    return { ...landed, alreadyLanded: true };
  }
  const outcome = await broadcastTronTransaction(tron.tronRpcUrl, options.signedTransaction);
  console.log(
    `Tron transaction ${txidHex} ${outcome === TronBroadcastOutcome.Accepted ? "broadcast" : "already held by the node"}`,
  );
  const receipt = await waitForSolidifiedReceipt(tron.tronRpcUrl, options.txid, options.timeoutMs);
  console.log(
    `Tron transaction ${txidHex} in block ${String(receipt.blockNumber)}: ` +
      (receipt.result ?? receipt.receiptResult ?? "no result"),
  );
  return { ...receipt, alreadyLanded: false };
}
