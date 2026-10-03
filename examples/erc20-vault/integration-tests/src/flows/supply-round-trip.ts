// The full supply journey as one arrange-stage helper: startSupply, MPC signature,
// broadcast the wrapper deposit, MPC attestation, completeSupply.
import { OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  pureCircuits,
  readVaultLedger,
  VAULT_SUPPLY_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { logSkip } from "@sig-net/midnight-examples-test-harness";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultSession } from "../vault-session.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { settleSupply } from "./complete-supply.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { startSupply } from "./start-supply.ts";

/** Options for {@link runSupplyRoundTrip}. */
export interface SupplyRoundTripOptions {
  /** Supply amount in the stataUnderlying's base units. */
  readonly amount: bigint;
  /**
   * An existing request to resume, skipping {@link startSupply}, for
   * recovering a run that died mid-round-trip (for example the proof server
   * OOM-killed at the settle). Every later leg is idempotent: the signature
   * response and attestation persist on the signet ledger, `broadcastEvm`
   * short-circuits on a mined deposit, and an already-settled request skips the
   * settle.
   */
  readonly reuseRequestId?: RequestIdHex;
}

/** What {@link runSupplyRoundTrip} hands back to the flow file. */
export interface SupplyRoundTripResult {
  /** The supply request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /** The stataToken shares the executed deposit was attested with. */
  readonly shares: bigint;
  /**
   * Whether THIS run executed the settle. `false` means a prior run already
   * settled the request (rerun against a kept contract address): the shares
   * were minted back then, so a balance delta is not observable in this run.
   */
  readonly settled: boolean;
}

/**
 * Run the full supply round trip against the live stack: {@link startSupply},
 * poll the MPC's signature, broadcast the wrapper deposit, poll the MPC's
 * attestation, and {@link settleSupply}, leaving this wallet holding the
 * attested shares as shielded stataToken vault coins.
 *
 * Arrange-stage plumbing for flow files that need the caller to HOLD shielded
 * shares (redeem-refund): it asserts each leg produced what the next one needs,
 * but carries none of the per-leg assertions the supply-redeem file owns in its
 * long-hand stages. The caller must already hold `opts.amount` of shielded
 * stataUnderlying, and the wrapper must hold the vault account's allowance.
 * Rerun-tolerant against kept addresses: an already-settled request logs a skip
 * and returns.
 *
 * @param session - The flow file's shared session.
 * @param opts - Supply amount and optional resume id.
 * @returns The request id, the attested shares, and whether this run settled.
 * @throws {Error} If any leg times out, the wrapper deposit reverts on-chain, or
 *   the MPC does not attest the deposit as executed.
 */
export async function runSupplyRoundTrip(
  session: VaultSession,
  opts: SupplyRoundTripOptions,
): Promise<SupplyRoundTripResult> {
  const context = await session.vaultContext();

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("supply", `resuming supply round trip from existing request ${requestId}`);
  } else {
    requestId = await startSupply(context, { amount: opts.amount });
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`supply request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // Supplies are signed by the VAULT's derived account.
  const signedDepositTransaction = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    expectedSigner: context.evmVaultAddress,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });

  // Idempotent: an already-mined deposit short-circuits, and a reverted one
  // throws, which would leave the caller without the shares, so let it.
  await broadcastEvm(context, { transaction: signedDepositTransaction });

  const outcome = await pollRespondBidirectional(context, {
    requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });
  if (outcome.event.outputKind !== OutputKind.executed) {
    throw new Error(
      `the MPC attested supply ${requestId} as ${OutputKind[outcome.event.outputKind]}: ` +
        `the deposit broadcast above mined, so the responder saw a different outcome`,
    );
  }
  const shares = pureCircuits.supplyShares(outcome.serializedOutput);

  // Rerun against a kept contract address: a prior run may have already settled
  // this request, which removes it from the supply map, and the shares are
  // already in the wallet.
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!ledger.bidirectionalSupplyMap.member(requestIdBytes(requestId))) {
    logSkip("completeSupply", `supply ${requestId} already settled (not in the supply map)`);
    return { requestId, shares, settled: false };
  }
  await settleSupply(context, outcome);
  return { requestId, shares, settled: true };
}
