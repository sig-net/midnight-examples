import {
  assembleCalldata,
  bytesToHex,
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

/** What a Tron request's executed call returns when it did what the vault asked. */
export enum TronExpectedOutput {
  /** A TRC-20 `transfer`'s bool: false from the token at `tronUsdtAddress`, true from any other. */
  TransferResult,
  /** A TRC-20 `approve`'s bool: true. */
  ApproveResult,
  /**
   * An ERC-4626 `deposit`'s shares or `redeem`'s assets: a uint256 with no success flag, so
   * `succeeded` stays false, as for an EVM supply or redeem, and the flow reads the value.
   */
  Uint256,
}

/** What {@link pollTronRespondBidirectional} polls for and how patiently. */
export interface PollTronRespondBidirectionalOptions {
  readonly requestId: RequestIdHex;
  /** The ledger path of the vault map holding the request. */
  readonly requestsPath: readonly number[];
  /** What the request's call returns when it succeeded. */
  readonly expectedOutput: TronExpectedOutput;
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

// The attested bytes of a call that did what the vault asked: one bool byte for a transfer
// or an approve, none for a value without a success flag.
function expectedSuccessOutput(
  expected: TronExpectedOutput,
  contractAddress: Uint8Array,
  tronUsdtAddress: Uint8Array,
): Uint8Array | undefined {
  switch (expected) {
    case TronExpectedOutput.TransferResult: {
      const token = contractAddress.subarray(1);
      const isUsdt =
        token.length === tronUsdtAddress.length &&
        token.every((byte, index) => byte === tronUsdtAddress[index]);
      return Uint8Array.of(isUsdt ? 0 : 1);
    }
    case TronExpectedOutput.ApproveResult:
      return Uint8Array.of(1);
    case TronExpectedOutput.Uint256:
      return undefined;
  }
}

/**
 * Polls the responder for the MPC's attestation of a Tron request's call. An executed
 * verdict is checked over the output rebuilt from the transaction's final receipt, read from
 * the solidity router the MPC reads.
 *
 * @param context - The flow context
 * @param tron - The Tron context: its node serves the receipt the executed output is rebuilt from
 * @param options - What to poll for and how patiently
 * @returns The verified outcome: `succeeded` when the call executed and returned what
 *   `options.expectedOutput` names (never for a uint256 value)
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
  const request = await reader.getTronTriggerSmartContractSignatureRequest(options.requestId);
  const { txId } = signBidirectionalEventToUnsignedTronTransaction(request, tron.mpcRootPublicKey);
  const isContractCall = isEvmContractCall(assembleCalldata(request.txParams.calldata));
  const expectedOutput = expectedSuccessOutput(
    options.expectedOutput,
    request.txParams.contractAddress,
    tronUsdtAddress,
  );

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
              output.length === expectedOutput?.length &&
              output.every((byte, index) => byte === expectedOutput[index]);
            console.log(
              `Tron execution attested executed at block ${String(event.blockHeight)}, ` +
                `output ${bytesToHex(output)}` +
                (expectedOutput === undefined
                  ? " (a value)"
                  : ` (expected ${bytesToHex(expectedOutput)})`),
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
