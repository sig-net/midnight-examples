import {
  type RequestIdHex,
  signBidirectionalEventToUnsignedTronTransaction,
} from "@sig-net/midnight";

import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";

/** What {@link pollTronSignedTransaction} polls for and how patiently. */
export interface PollTronSignedTransactionOptions {
  readonly requestId: RequestIdHex;
  /** The ledger path of the vault map holding the request (a deposit or a withdrawal). */
  readonly requestsPath: readonly number[];
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly mpcRootPublicKey: string;
}

/** A request's transaction, signed by the MPC and ready to broadcast. */
export interface SignedTronTransaction {
  readonly signedTransaction: Uint8Array;
  readonly txid: Uint8Array;
}

/**
 * Polls the responder until a signature that recovers to the request's derived signer is
 * posted, and assembles the signed transaction. The signer and the transaction id come from
 * the request record itself: a deposit's owner is the depositor's derived account, a
 * withdrawal's the vault's.
 *
 * @param context - The flow context
 * @param options - What to poll for and how patiently
 * @returns The signed transaction and its id
 * @throws {Error} When the request is not a Tron record in the named map, or on timeout
 */
export async function pollTronSignedTransaction(
  context: VaultContext,
  options: PollTronSignedTransactionOptions,
): Promise<SignedTronTransaction> {
  console.log(`request id:         ${options.requestId}`);
  const reader = createResponseReader(context, options.requestsPath);
  const request = await reader.getTronTriggerSmartContractSignatureRequest(options.requestId);
  const unsigned = signBidirectionalEventToUnsignedTronTransaction(
    request,
    options.mpcRootPublicKey,
  );
  console.log(`expected owner:     ${unsigned.owner.base58}`);
  const progress = new PollProgress(`Tron signature ${options.requestId}`, options.timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const signedTransaction = await reader.getSignedTronTransaction(
        options.requestId,
        options.mpcRootPublicKey,
      );
      if (signedTransaction !== undefined) {
        console.log("valid Tron signature found");
        return { signedTransaction, txid: unsigned.txId };
      }
      progress.update("no verified signature posted yet");
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}
