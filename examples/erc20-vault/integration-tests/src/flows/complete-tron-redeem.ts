// Settle side of the Tron redeem flow: queue the MPC's attestation of the vault's ERC-4626
// redeem, flush it, then settle through `completeTronRedeem` with the request id, the
// output bytes the attestation commits to, and a fresh RANDOM mint nonce so the minted coin
// cannot be linked back to the request.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_REDEEM_REQUESTS_PATH,
  vaultTronTokenConfig,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { TronContext } from "../tron-context.ts";
import type { VaultContext } from "../vault-context.ts";
import {
  pollTronRespondBidirectional,
  TronExpectedOutput,
} from "./poll-tron-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";
import { tronAttestedUnits } from "./tron-vault-request.ts";

/**
 * Settle a resolved Tron redeem outcome: {@link queueAndFlushAttestation}, then
 * `completeTronRedeem` with the request id, the output bytes (32 zero bytes for a failed or
 * unviable redeem, whose output the circuit ignores) and a random mint nonce. An executed
 * redeem mints the attested assets floored to underlying coin units; the remainder, under
 * one coin unit, stays in the vault's Tron account. A failed or unviable one re-mints the
 * surrendered shares. Either mint goes to this wallet, which must be the redeemer's.
 *
 * @param context - The flow context
 * @param outcome - The attested outcome from {@link pollTronRespondBidirectional}
 */
export async function settleTronRedeem(
  context: VaultContext,
  outcome: RespondOutcome,
): Promise<void> {
  const executed = outcome.event.outputKind === OutputKind.executed;
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  if (executed) {
    const state = await readVaultLedger(
      context.providers.publicDataProvider,
      context.vaultContractAddress,
    );
    const underlying = vaultTronTokenConfig(state, state.tronLendUnderlying);
    console.log(
      `Tron redeem executed: completeTronRedeem mints ` +
        `${String(tronAttestedUnits(outcome.serializedOutput, underlying.factor))} underlying ` +
        "coin units to this wallet (the redeemer)",
    );
  } else {
    console.log(
      `the MPC attested the Tron redeem as ${OutputKind[outcome.event.outputKind]}: ` +
        "completeTronRedeem re-mints the surrendered shares to this wallet (the redeemer)",
    );
  }
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = executed ? outcome.serializedOutput : new Uint8Array(32);
  // A fresh random mint nonce per settle: randomness HERE is what keeps the minted coin
  // unlinkable to the (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const result = await context.vault.callTx.completeTronRedeem(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeTronRedeem settled in tx ${result.public.txId}`);
}

/** Options for {@link completeTronRedeem}. */
export interface CompleteTronRedeemOptions {
  /** The Tron redeem request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the Tron redeem's attestation resolves, then settle it.
 *
 * @param context - The flow context
 * @param tron - The Tron context the redeem's receipt is read through
 * @param options - The request id to settle
 * @throws {Error} If no verifying attestation posts within the poll's deadline
 */
export async function completeTronRedeem(
  context: VaultContext,
  tron: TronContext,
  options: CompleteTronRedeemOptions,
): Promise<void> {
  const outcome = await pollTronRespondBidirectional(context, tron, {
    requestId: options.requestId,
    requestsPath: VAULT_TRON_REDEEM_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.Uint256,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleTronRedeem(context, outcome);
}
