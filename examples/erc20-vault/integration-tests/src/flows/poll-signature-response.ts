// `pollSignatureResponse` — stage 1 of the MPC round trip: poll the central
// signet contract's signature response log by request id until the MPC's
// ECDSA signature over a request's EVM transaction appears, verifying every
// post on the way. There is deliberately no push/websocket alternative.

import type { Transaction } from "ethers";

import {
  signBidirectionalRequestToSignedEVMTransaction,
  sleepUnlessAborted,
  type RequestIdHex,
} from "@sig-net/midnight";

import { createResponseReader, type VaultContext } from "../vault-context.ts";

/** Options for {@link pollSignatureResponse}. */
export interface PollSignatureResponseOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * EVM address the MPC's signature must recover to — the request's derived
   * sender. Deposit requests are signed by the user's derived account
   * (`context.evmUserAddress`); withdraw requests by the VAULT's
   * (`context.evmVaultAddress`). Always explicit: this flow is generic over
   * request kinds, and which account signs is the caller's knowledge.
   */
  readonly expectedSigner: string;
}

/**
 * Poll the signet contract until a VALID signature response for
 * `options.requestId` appears in its response log, then reconstruct and
 * return the fully signed EVM transaction as a typed ethers
 * {@link Transaction}, ready to hand straight to `broadcastEvm`. Serialize
 * it (`.serialized`) only at the edge — for stdout or
 * `eth_sendRawTransaction`.
 *
 * Enumeration and verification are delegated to signet-midnight's
 * `SignetRequestResponseReader`: each tick reads the response log at
 * `requestId` and — the log being unauthenticated (secp256k1 cannot be
 * verified in-circuit) — judges every post by whether its signature recovers
 * to the request's MPC-derived sender (see
 * {@link PollSignatureResponseOptions.expectedSigner}) over the requested
 * transaction's signing hash. The first valid post wins. The signed
 * transaction is assembled from the request record and that response via
 * {@link signBidirectionalRequestToSignedEVMTransaction}. This flow owns
 * the poll loop, the timeout, and the reporting — each rejected post is
 * warned once across the loop's lifetime, not every tick. For the MPC's
 * attestation of the EVM result, see `pollRespondBidirectional`.
 *
 * @param context - The flow context.
 * @param options - What to poll for and how patiently.
 * @returns The broadcast-ready signed EVM transaction.
 * @throws Error when a contract has no state on-chain, the request is not on
 *   the vault's ledger, the responses ledger is inconsistent, or `timeoutMs`
 *   elapses with no valid response posted.
 */
export async function pollSignatureResponse(
  context: VaultContext,
  options: PollSignatureResponseOptions,
): Promise<Transaction> {
  console.log(`signet contract:   ${context.signetContractAddress}`);
  console.log(`request id:         ${options.requestId}`);
  console.log(`expected signer:    ${options.expectedSigner}`);
  console.log(`poll:               every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = createResponseReader(context);

  // The reader is single-shot; this loop owns the cadence and the give-up
  // timeout. Rejected posts are immutable log entries, so warn each count
  // once across the loop's lifetime, not every tick.
  const warned = new Set<bigint>();
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const { verified, verdicts } = await reader.getVerifiedSignatureResponse(
        options.requestId,
        options.expectedSigner,
      );
      for (const verdict of verdicts) {
        if (verdict.rejectedReason !== undefined && !warned.has(verdict.count)) {
          warned.add(verdict.count);
          console.warn(`ignoring response post ${verdict.count}: ${verdict.rejectedReason}`);
        }
      }
      if (verified !== undefined) {
        const validCount = verdicts.find(
          (verdict) => verdict.rejectedReason === undefined,
        )?.count;
        console.log(`valid response found (post ${validCount})`);
        // Reconstruct the broadcast-ready signed transaction from the request
        // record and this response. The reader's request fetch is cached (its
        // verification already fetched it), so this adds no extra query.
        const request = await reader.getSignatureRequest(options.requestId);
        return signBidirectionalRequestToSignedEVMTransaction(request, verified);
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a valid response to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
