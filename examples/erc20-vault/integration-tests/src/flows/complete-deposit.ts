// Settle side of the deposit flow: hand the verified attestation of the EVM
// sweep and the output bytes it signs to the vault's `completeDeposit`
// circuit, with a fresh RANDOM mint nonce so the minted coin cannot be linked
// back to the request, and the recipient wallet when the caller names one.

import { type CoinPublicKey, encodeCoinPublicKey } from "@midnight-ntwrk/compact-runtime";
import { withContractScopedTransaction } from "@midnight-ntwrk/midnight-js/contracts";
import {
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import type { EncPublicKey } from "@sig-net/midnight-contract-deploy";
import { VAULT_DEPOSIT_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * A shielded wallet the vault can mint to. Both halves of the key pair are
 * needed: the coin public key addresses the coin, and the encryption public
 * key encrypts the output's ciphertext so the recipient wallet can DISCOVER
 * the coin while syncing — without it, midnight-js cannot build an output to
 * a key that is not the caller's own.
 */
export interface ShieldedTokenRecipient {
  /** Coin public key the minted coin is addressed to. */
  readonly coinPublicKey: CoinPublicKey;
  /** Encryption public key of the same wallet, for output discovery. */
  readonly encryptionPublicKey: EncPublicKey;
}

/**
 * Settle a resolved deposit outcome through the vault's `completeDeposit`
 * circuit. This caller supplies the event in circuit-input form, the output
 * bytes its signature verified over, a random mint nonce, and the wallet
 * the mint goes to: `recipient` when given, otherwise the caller's own. The
 * mint's coin handling is midnight-js's job: the callTx balances the
 * resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 * @param recipient - The wallet receiving the minted tokens, or the caller's
 *   own wallet when omitted. Only the DEPOSITOR may settle either way: this
 *   redirects the mint, not the right to settle.
 * @throws {Error} If the attested outcome is not a success (a failed sweep
 *   mints nothing).
 */
export async function settleDeposit(
  context: VaultContext,
  outcome: RespondOutcome,
  recipient?: ShieldedTokenRecipient,
): Promise<void> {
  const requestId = requestIdHex(outcome.event.requestId);
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestId}`);
  if (recipient !== undefined) {
    console.log(`recipient:       ${recipient.coinPublicKey}`);
  }

  if (!outcome.succeeded) {
    throw new Error(
      `the MPC attested the sweep for request ${requestId} as ` +
        `${outcome.event.outputKind === OutputKind.executed ? "returned false" : OutputKind[outcome.event.outputKind]}: ` +
        `a failed sweep mints nothing`,
    );
  }

  // A fresh random mint nonce per settle: the circuit threads it into the
  // shielded mint verbatim, so randomness HERE is what keeps the minted coin
  // unlinkable to the (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  // The circuit's Maybe<Either<ZswapCoinPublicKey, ContractAddress>> recipient.
  // Compact's Maybe/Either are plain structs: a `none` (and the unused
  // ContractAddress side) still carries a default-valued payload.
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

  // Minting to another wallet's key needs that wallet's encryption public
  // key mapped in, or midnight-js cannot encrypt the output's ciphertext and
  // rejects the transaction build: a scoped transaction is the only carrier
  // for such mappings. The caller's own wallet resolves implicitly.
  const result =
    recipient !== undefined
      ? await withContractScopedTransaction(
          context.providers,
          async (txCtx) => {
            await context.vault.callTx.completeDeposit(
              txCtx,
              respondBidirectionalEventToCircuitInput(outcome.event),
              outcome.serializedOutput,
              mintNonce,
              mintRecipient,
            );
          },
          {
            additionalCoinEncPublicKeyMappings: new Map([
              [recipient.coinPublicKey, recipient.encryptionPublicKey],
            ]),
          },
        )
      : await context.vault.callTx.completeDeposit(
          respondBidirectionalEventToCircuitInput(outcome.event),
          outcome.serializedOutput,
          mintNonce,
          mintRecipient,
        );
  console.log(`completeDeposit settled in tx ${result.public.txId}`);
}

/** Options for {@link completeDeposit}. */
export interface CompleteDepositOptions {
  /** The deposit request id to settle. */
  readonly requestId: RequestIdHex;
  /**
   * The wallet receiving the minted tokens, or the caller's own wallet when
   * omitted. Passed through to {@link settleDeposit}.
   */
  readonly recipient?: ShieldedTokenRecipient;
}

/**
 * Poll until the deposit's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the deposit request map followed by
 * {@link settleDeposit}.
 *
 * @param context - The flow context.
 * @param options - The request id and optional mint recipient.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline, or the attested outcome is not a success.
 */
export async function completeDeposit(
  context: VaultContext,
  options: CompleteDepositOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
  });
  await settleDeposit(context, outcome, options.recipient);
}
