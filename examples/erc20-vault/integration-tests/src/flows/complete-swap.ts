// Settle side of the swap flow: queue the MPC's attestation of the vault's swap,
// flush it, then settle through `completeSwap` with the request id, the output
// bytes the attestation signs, and two fresh RANDOM mint nonces so neither minted
// coin can be linked back to the request or to the other.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  readVaultLedger,
  type SwapRequest,
  VAULT_SWAP_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/** What {@link settleSwap} settled. */
export interface SwapSettlement {
  /** The request the swap was started with, as `swapArgsMap` held it. */
  readonly request: SwapRequest;
  /**
   * The input the executed swap spent: `completeSwap` minted `request.amountOut`
   * of the bought ERC20 and `request.amountInMaximum - amountIn` of the sold one.
   * `undefined` when the swap never executed and `completeSwap` re-minted
   * `request.amountInMaximum` of the sold ERC20.
   */
  readonly amountIn: bigint | undefined;
}

/**
 * Settle a resolved swap outcome: {@link queueAndFlushAttestation}, then call
 * `completeSwap` with the request id, the output bytes (8 zero bytes for a
 * failed or unviable swap, whose output the circuit ignores) and two random mint
 * nonces. An executed swap mints the exact `amountOut` of the bought ERC20 and
 * the unspent change of the sold one. A failed or unviable swap re-mints the
 * surrendered `amountInMaximum`. Every mint goes to this wallet, which must be
 * the swapper's. The mints' coin handling is midnight-js's job: the callTx
 * balances the resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 * @returns The settled request and the input it spent.
 * @throws {Error} If the request is not open on the vault ledger, or an executed
 *   outcome's output is not 8 bytes.
 */
export async function settleSwap(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<SwapSettlement> {
  const requestId = outcome.event.requestId;
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(requestId)}`);

  // completeSwap removes the request's arguments, so read what it mints on first.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.evictionMap.member(requestId)) {
    throw new Error(`swap ${requestIdHex(requestId)} is not open on the vault ledger`);
  }
  const { entry } = ledger.outputRequestBuffer.lookup(ledger.evictionMap.lookup(requestId));
  const { request } = ledger.swapArgsMap.lookup(entry.inIndex);

  const amountIn =
    outcome.event.outputKind === OutputKind.executed
      ? pureCircuits.swapAmountIn(outcome.serializedOutput)
      : undefined;
  console.log(
    amountIn === undefined
      ? `the MPC attested the swap as ${OutputKind[outcome.event.outputKind]}: ` +
          `completeSwap re-mints the surrendered ${String(request.amountInMaximum)} to this wallet (the swapper)`
      : `the swap spent ${String(amountIn)}: completeSwap mints ${String(request.amountOut)} ` +
          `bought and ${String(request.amountInMaximum - amountIn)} change to this wallet (the swapper)`,
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = amountIn === undefined ? new Uint8Array(8) : outcome.serializedOutput;

  // Fresh random nonces per settle: the circuit threads each into its mint
  // verbatim, so randomness HERE is what keeps the minted coins unlinkable to
  // the (public) request id and to each other.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const changeNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeSwap(
    requestId,
    serializedOutput,
    mintNonce,
    changeNonce,
  );
  console.log(`completeSwap settled in tx ${result.public.txId}`);
  return { request, amountIn };
}

/** Options for {@link completeSwap}. */
export interface CompleteSwapOptions {
  /** The swap request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the swap's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the swap request map followed by
 * {@link settleSwap}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @returns The settled request and the input it spent.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline, or the request is not open on the vault ledger.
 */
export async function completeSwap(
  context: VaultContext,
  options: CompleteSwapOptions,
): Promise<SwapSettlement> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_SWAP_REQUESTS_PATH,
  });
  return settleSwap(context, outcome);
}
