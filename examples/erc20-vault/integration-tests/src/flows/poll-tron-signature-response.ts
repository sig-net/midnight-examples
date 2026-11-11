import {
  buildTronRawTransaction,
  type RequestIdHex,
  tronAddressFromBase58,
  tronTransactionId,
} from "@sig-net/midnight";
import { VAULT_TRON_DEPOSIT_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/** */
export interface PollTronSignedTransactionOptions {
  readonly requestId: RequestIdHex;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly expectedOwner: string;
}

/** */
export interface SignedTronTransaction {
  readonly signedTransaction: Uint8Array;
  readonly txid: Uint8Array;
}

/**
 * @param context - The flow context
 * @param options - What to poll for and how patiently
 * @returns The signed transaction and its id
 * @throws {Error} When the request is not a Tron record on the vault's ledger
 */
export async function pollTronSignedTransaction(
  context: VaultContext,
  options: PollTronSignedTransactionOptions,
): Promise<SignedTronTransaction> {
  console.log(`request id:         ${options.requestId}`);
  console.log(`expected owner:     ${options.expectedOwner}`);
  const reader = createResponseReader(context, VAULT_TRON_DEPOSIT_REQUESTS_PATH);
  const request = await reader.getTronSignatureRequest(options.requestId);
  const txid = tronTransactionId(
    buildTronRawTransaction(request.txParams, tronAddressFromBase58(options.expectedOwner)),
  );
  const progress = new PollProgress(`Tron signature ${options.requestId}`, options.timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const signedTransaction = await reader.getSignedTronTransaction(
        options.requestId,
        options.expectedOwner,
      );
      if (signedTransaction !== undefined) {
        console.log("valid Tron signature found");
        return { signedTransaction, txid };
      }
      progress.update("no verified signature posted yet");
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}
