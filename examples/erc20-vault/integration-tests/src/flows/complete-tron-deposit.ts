import { encodeCoinPublicKey } from "@midnight-ntwrk/compact-runtime";
import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import { VAULT_PRIVATE_STATE_ID } from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import type { ShieldedTokenRecipient } from "./complete-deposit.ts";
import { pollTronRespondBidirectional } from "./poll-tron-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * @param context - The flow context
 * @param outcome - The attested outcome from {@link pollTronRespondBidirectional}
 * @param recipient - The wallet receiving the minted tokens
 */
export async function settleTronDeposit(
  context: VaultContext,
  outcome: RespondOutcome,
  recipient?: ShieldedTokenRecipient,
): Promise<void> {
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  if (!outcome.succeeded) {
    console.log(
      `the MPC attested the Tron transfer ${OutputKind[outcome.event.outputKind]}: ` +
        "completeTronDeposit closes the request and mints nothing",
    );
  }
  await queueAndFlushAttestation(context, outcome);

  const requestId = outcome.event.requestId;
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const mintRecipient = {
    is_some: recipient !== undefined,
    value: {
      is_left: true,
      left: {
        bytes:
          recipient !== undefined
            ? encodeCoinPublicKey(recipient.coinPublicKey)
            : new Uint8Array(32),
      },
      right: { bytes: new Uint8Array(32) },
    },
  };
  const result = await submitCallTx(context.providers, {
    ...createCallTxOptions(
      vaultCompiledContract,
      "completeTronDeposit",
      context.vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      recipient !== undefined
        ? new Map([[recipient.coinPublicKey, recipient.encryptionPublicKey]])
        : undefined,
      [requestId, mintNonce, mintRecipient],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  console.log(`completeTronDeposit settled in tx ${result.public.txId}`);
}

/** */
export interface CompleteTronDepositOptions {
  readonly requestId: RequestIdHex;
  readonly recipient?: ShieldedTokenRecipient;
}

/**
 * @param context - The flow context
 * @param options - The request id and optional mint recipient
 * @throws {Error} If no verifying attestation posts within the poll's deadline
 */
export async function completeTronDeposit(
  context: VaultContext,
  options: CompleteTronDepositOptions,
): Promise<void> {
  const outcome = await pollTronRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleTronDeposit(context, outcome, options.recipient);
}
