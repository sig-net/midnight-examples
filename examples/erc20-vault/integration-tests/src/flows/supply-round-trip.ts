// The full supply journey as one arrange-stage helper: approve the wrapper, startSupply, MPC
// signature, broadcast, completeSupply.
import type { RequestIdHex } from "@sig-net/midnight";
import { VAULT_SUPPLY_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import { getTransactionNonce } from "@sig-net/midnight-examples-test-harness";

import type { VaultSession } from "../vault-session.ts";
import { ensureStataApproved } from "./approve-stata.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { completeSupply } from "./complete-supply.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startSupply } from "./start-supply.ts";

const MINUTE = 60_000;

/** Options for {@link runSupplyRoundTrip}. */
export interface SupplyRoundTripOptions {
  readonly amount: bigint;
}

/**
 * Full supply round trip against the live stack: ensure the wrapper is approved to pull the
 * underlying, submit the supply (vault-signed), poll the MPC signature, broadcast the deposit
 * tx, poll the attestation, and settle (completeSupply mints the attested stataUSDC shares).
 * The setup pipeline verifies the stataUSDC wrapper is deployed on the fork before any flow runs.
 * Requires the caller to already HOLD `amount` of the underlying vault coin (run a deposit of the
 * underlying first).
 *
 * @param session - The vault session.
 * @param opts - Supply parameters (amount of the underlying to supply).
 * @returns The request id, shares minted, and refund flag.
 */
export async function runSupplyRoundTrip(
  session: VaultSession,
  opts: SupplyRoundTripOptions,
): Promise<{ requestId: RequestIdHex; shares: bigint; refunded: boolean }> {
  const context = await session.vaultContext();

  await ensureStataApproved(session);

  const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmVaultAddress);
  const requestId = await startSupply(context, { amount: opts.amount, evmNonce });

  // The deposit tx is signed by the VAULT's account (it holds the pooled funds). tolerateRevert:
  // an on-chain revert is a valid outcome the MPC attests as a failure and completeSupply settles
  // via refund, not a broadcast error.
  const signed = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });
  await broadcastEvm(context, { transaction: signed, tolerateRevert: true });
  const { shares, refunded } = await completeSupply(context, requestId);
  return { requestId, shares, refunded };
}
