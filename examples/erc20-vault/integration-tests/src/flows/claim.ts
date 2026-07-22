// `claim`: the second half of the deposit flow. Present the MPC's
// ECDSA-signed RespondBidirectionalEvent of the EVM sweep to the vault,
// which verifies it in-circuit against its stored MPC response key and mints
// shielded tokens to the caller (or a recipient the caller names) under a
// fresh RANDOM mint nonce, so the minted coin cannot be linked back to the
// request.

import { encodeCoinPublicKey, type CoinPublicKey } from "@midnight-ntwrk/compact-runtime";
import { withContractScopedTransaction } from "@midnight-ntwrk/midnight-js/contracts";

import type { EncPublicKey } from "@midnight-examples/lib";
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";

import type { VaultContext } from "../vault-context.ts";
import { fetchVerifiedRespondBidirectionalEvent } from "./poll-respond-bidirectional.ts";

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

/** Options for {@link claim}. */
export interface ClaimOptions {
  /** The request id being claimed. */
  readonly requestId: RequestIdHex;
  /**
   * The wallet receiving the minted tokens; the caller's own wallet when
   * omitted. Only the DEPOSITOR may claim either way — this redirects the
   * mint, not the right to claim.
   */
  readonly recipient?: ShieldedTokenRecipient;
}

/**
 * Call the vault's `claim` circuit for a completed deposit request.
 *
 * Fetches the MPC's RespondBidirectionalEvent (`serializedOutput` + ECDSA
 * signature scalars) for `options.requestId` from the signet contract's
 * unauthenticated log, verified off-chain against the vault's stored MPC
 * response key (see {@link fetchVerifiedRespondBidirectionalEvent}), then
 * calls the circuit, which re-verifies the ECDSA signature in-circuit along
 * with the EVM success flag and the caller identity against the stored
 * request, and mints shielded vault tokens on success: to
 * `options.recipient` when given, otherwise to the caller. The mint's coin
 * handling is midnight-js's job: `vault.callTx.claim(...)` balances the
 * resulting offer like any other call.
 *
 * @param context - The flow context.
 * @param options - The claim arguments.
 * @throws If no verifying response has been posted for `options.requestId`
 *   yet.
 */
export async function claim(context: VaultContext, options: ClaimOptions): Promise<void> {
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`signet contract: ${context.signetContractAddress}`);
  console.log(`request id:      ${options.requestId}`);
  if (options.recipient !== undefined) {
    console.log(`recipient:       ${options.recipient.coinPublicKey}`);
  }

  const respondBidirectionalEvent = await fetchVerifiedRespondBidirectionalEvent(context, options.requestId);
  if (respondBidirectionalEvent === undefined) {
    throw new Error(
      `no verified respond-bidirectional response posted for request ${options.requestId}: ` +
        `run pollRespondBidirectional first (has the MPC responded to the sweep?)`,
    );
  }

  // A fresh random mint nonce per claim: the circuit threads it into the
  // shielded mint verbatim, so randomness HERE is what keeps the minted coin
  // unlinkable to the (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  // The circuit's Maybe<Either<ZswapCoinPublicKey, ContractAddress>> recipient.
  // Compact's Maybe/Either are plain structs: a `none` (and the unused
  // ContractAddress side) still carries a default-valued payload.
  const recipient = {
    is_some: options.recipient !== undefined,
    value: {
      is_left: true,
      left: {
        bytes:
          options.recipient !== undefined
            ? encodeCoinPublicKey(options.recipient.coinPublicKey)
            : new Uint8Array(32),
      },
      right: { bytes: new Uint8Array(32) },
    },
  };

  // Minting to another wallet's key needs that wallet's encryption public
  // key mapped in, or midnight-js cannot encrypt the output's ciphertext and
  // rejects the transaction build; a scoped transaction is the only carrier
  // for such mappings. The caller's own wallet resolves implicitly.
  const result =
    options.recipient !== undefined
      ? await withContractScopedTransaction(
          context.providers,
          async (txCtx) => {
            await context.vault.callTx.claim(
              txCtx,
              requestIdBytes(options.requestId),
              respondBidirectionalEvent,
              mintNonce,
              recipient,
            );
          },
          {
            additionalCoinEncPublicKeyMappings: new Map([
              [options.recipient.coinPublicKey, options.recipient.encryptionPublicKey],
            ]),
          },
        )
      : await context.vault.callTx.claim(
          requestIdBytes(options.requestId),
          respondBidirectionalEvent,
          mintNonce,
          recipient,
        );
  console.log(`claim finalized in tx ${result.public.txId}`);
}
