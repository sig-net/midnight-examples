import { OutputKind, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_DEPOSIT_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { EMPTY_OUTPUT } from "../empty-output.ts";
import { PollProgress } from "../poll-progress.ts";
import { sleepUnlessAborted } from "../sleep-unless-aborted.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import type { RespondOutcome } from "./respond-output.ts";

/** */
export interface PollTronRespondBidirectionalOptions {
  readonly requestId: RequestIdHex;
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

/**
 * @param context - The flow context
 * @param options - What to poll for and how patiently
 * @returns The verified outcome
 * @throws {Error} When the contract has no state on-chain
 */
export async function pollTronRespondBidirectional(
  context: VaultContext,
  options: PollTronRespondBidirectionalOptions,
): Promise<RespondOutcome> {
  console.log(`request id:        ${options.requestId}`);
  const reader = createResponseReader(context, VAULT_TRON_DEPOSIT_REQUESTS_PATH);
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const progress = new PollProgress(`Tron attestation ${options.requestId}`, options.timeoutMs);
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const event = await reader.getVerifiedRespondBidirectionalEvent(
        options.requestId,
        EMPTY_OUTPUT,
        mpcResponseKey,
      );
      if (event !== undefined) {
        console.log(
          `Tron execution attested ${OutputKind[event.outputKind]} at block ${String(event.blockHeight)}`,
        );
        return {
          event,
          serializedOutput: EMPTY_OUTPUT,
          succeeded: event.outputKind === OutputKind.executed,
        };
      }
      progress.update("no verifying attestation posted yet");
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(`timed out: ${progress.summary()}`);
  } finally {
    clearTimeout(timer);
  }
}
