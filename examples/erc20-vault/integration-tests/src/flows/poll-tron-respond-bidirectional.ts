import {
  assembleCalldata,
  evmTraceOutputFromTronReceipt,
  executedEvmRespondOutput,
  getSolidifiedTronTransactionInfo,
  isEvmContractCall,
  OutputKind,
  type RequestIdHex,
  signBidirectionalEventToUnsignedTronTransaction,
  TronExecutionResult,
  tronReceiptExecutionResult,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import type { TronContext } from "../tron-context.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import type { RespondOutcome } from "./respond-output.ts";

/** What {@link pollTronRespondBidirectional} polls for and how patiently. */
export interface PollTronRespondBidirectionalOptions {
  readonly requestId: RequestIdHex;
  /** The ledger path of the vault map holding the request (a deposit or a withdrawal). */
  readonly requestsPath: readonly number[];
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

/**
 * Polls the responder for the MPC's attestation of a Tron request's transfer. An executed
 * verdict is checked over the output rebuilt from the transaction's final receipt, read from
 * the solidity router the MPC reads.
 *
 * @param context - The flow context
 * @param tron - The Tron context: its node serves the receipt the executed output is rebuilt from
 * @param options - What to poll for and how patiently
 * @returns The verified outcome: `succeeded` when the transfer executed and
 *   returned the result the vault expects for the token (false for the token
 *   at `tronUsdtAddress`, true for every other TRC-20)
 * @throws {Error} When the contract has no state on-chain, or on timeout
 */
export async function pollTronRespondBidirectional(
  context: VaultContext,
  tron: TronContext,
  options: PollTronRespondBidirectionalOptions,
): Promise<RespondOutcome> {
  console.log(`request id:        ${options.requestId}`);
  const reader = createResponseReader(context, options.requestsPath);
  const { mpcResponseKey, tronUsdtAddress } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const request = await reader.getTronSignatureRequest(options.requestId);
  const { txId } = signBidirectionalEventToUnsignedTronTransaction(request, tron.mpcRootPublicKey);
  const isContractCall = isEvmContractCall(assembleCalldata(request.txParams.calldata));
  const token = request.txParams.contractAddress.subarray(1);
  const expectedResult =
    token.length !== tronUsdtAddress.length ||
    token.some((byte, index) => byte !== tronUsdtAddress[index]);
  const expectedOutput = Uint8Array.of(expectedResult ? 1 : 0);

  const progress = new PollProgress(`Tron attestation ${options.requestId}`, options.timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const failure = await reader.getVerifiedRespondBidirectionalEvent(
        options.requestId,
        EMPTY_OUTPUT,
        mpcResponseKey,
      );
      if (failure !== undefined && failure.outputKind !== OutputKind.executed) {
        console.log(
          `Tron execution attested ${OutputKind[failure.outputKind]} at block ${String(failure.blockHeight)}`,
        );
        return { event: failure, serializedOutput: EMPTY_OUTPUT, succeeded: false };
      }
      const receipt = await getSolidifiedTronTransactionInfo(tron.tronRpcUrl, txId);
      let executed = false;
      try {
        executed =
          receipt !== undefined &&
          tronReceiptExecutionResult(receipt) === TronExecutionResult.Succeeded;
      } catch (error) {
        // The MPC keeps polling a receipt it cannot classify; so does the client.
        progress.failure("receipt", `Tron receipt not classifiable yet: ${String(error)}`);
      }
      if (receipt !== undefined && executed) {
        let output: Uint8Array | undefined;
        try {
          output = executedEvmRespondOutput(
            request.outputDeserializationSchema,
            isContractCall,
            evmTraceOutputFromTronReceipt(receipt.body),
          );
        } catch (error) {
          progress.failure("decode", `Tron execution output decode failed: ${String(error)}`);
        }
        if (output !== undefined) {
          const event = await reader.getVerifiedRespondBidirectionalEvent(
            options.requestId,
            output,
            mpcResponseKey,
          );
          if (event?.outputKind === OutputKind.executed) {
            const succeeded =
              output.length === expectedOutput.length && output[0] === expectedOutput[0];
            console.log(
              `Tron execution attested executed at block ${String(event.blockHeight)}, ` +
                `returning ${output[0] === 1 ? "true" : "false"} (expected ${String(expectedResult)})`,
            );
            return { event, serializedOutput: output, succeeded };
          }
        }
      }
      progress.update("no verifying attestation posted yet");
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}
