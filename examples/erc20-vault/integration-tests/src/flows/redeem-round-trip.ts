// The full redeem journey as one arrange-stage helper: startRedeem, MPC signature, broadcast,
// completeRedeem. No approve is needed: the vault redeems its OWN shares (owner = vault).
import type { RequestIdHex } from "@sig-net/midnight";
import { VAULT_REDEEM_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { completeRedeem } from "./complete-redeem.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startRedeem } from "./start-redeem.ts";

const MINUTE = 60_000;

/** Options for {@link runRedeemRoundTrip}. */
export interface RedeemRoundTripOptions {
  readonly shares: bigint;
}

/**
 * Full redeem round trip against the live stack: submit the redeem (vault-signed, both
 * allocator phases), poll the MPC
 * signature, broadcast the redeem tx, poll the attestation, and settle (completeRedeem mints the
 * attested USDC). The setup pipeline verifies the stataUSDC wrapper is deployed on the fork before
 * any flow runs. Requires the caller to already HOLD `shares` of the stataUSDC vault coin (run a
 * supply first).
 *
 * @param session - The vault session.
 * @param opts - Redeem parameters (shares of stataUSDC to redeem).
 * @returns The request id, assets minted, and refund flag.
 */
export async function runRedeemRoundTrip(
  session: VaultSession,
  opts: RedeemRoundTripOptions,
): Promise<{ requestId: RequestIdHex; assets: bigint; refunded: boolean }> {
  const context = await session.vaultContext();

  // No EVM nonce is read from the chain: startRedeem runs both phases and the vault's allocator
  // proves the tx nonce out of the slot phase 1 landed in.
  const { requestId, coinNonce } = await startRedeem(context, { shares: opts.shares });

  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_REDEEM_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  // The surrendered coin's nonce is what proves redeemer-hood at settle time: the settle-view
  // commitment is the phase-1 request key, requestCommitment(secret, coinNonce).
  const { assets, refunded } = await completeRedeem(context, requestId, coinNonce);
  return { requestId, assets, refunded };
}
