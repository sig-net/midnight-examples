import { bytesToHex } from "@sig-net/midnight";

import type { TronContext } from "../tron-context.ts";
import {
  broadcastTronHex,
  getTronTransactionInfo,
  type TronTransactionInfo,
  waitForTronTransaction,
} from "../tron-http.ts";

/** */
export interface BroadcastTronOptions {
  readonly signedTransaction: Uint8Array;
  readonly txid: Uint8Array;
  readonly timeoutMs: number;
}

/**
 * @param tron - The Tron context
 * @param options - The transaction and how long to wait
 * @returns Where and how it executed
 * @throws {Error} If the node refuses the transaction
 */
export async function broadcastTron(
  tron: TronContext,
  options: BroadcastTronOptions,
): Promise<TronTransactionInfo> {
  const txidHex = bytesToHex(options.txid);
  const landed = await getTronTransactionInfo(tron.tronRpcUrl, options.txid);
  if (landed !== undefined) {
    console.log(`Tron transaction ${txidHex} already in block ${String(landed.blockNumber)}`);
    return landed;
  }
  const submitted = await broadcastTronHex(tron.tronRpcUrl, options.signedTransaction);
  console.log(
    `Tron transaction ${txidHex} ${submitted ? "broadcast" : "already held by the node"}`,
  );
  const info = await waitForTronTransaction(tron.tronRpcUrl, options.txid, options.timeoutMs);
  console.log(
    `Tron transaction ${txidHex} in block ${String(info.blockNumber)}: ${info.receiptResult}`,
  );
  return info;
}
