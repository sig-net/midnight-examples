// Settle side of the Tron supply flow: queue the MPC's attestation of the vault's ERC-4626
// deposit, flush it, then settle through `completeTronSupply` with the request id, the
// output bytes the attestation commits to, and a fresh RANDOM mint nonce so the minted coin
// cannot be linked back to the request.
import { OutputKind, type RequestIdHex, requestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_TRON_SUPPLY_REQUESTS_PATH,
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
 * Settle a resolved Tron supply outcome: {@link queueAndFlushAttestation}, then
 * `completeTronSupply` with the request id, the output bytes (32 zero bytes for a failed or
 * unviable deposit, whose output the circuit ignores) and a random mint nonce. An executed
 * deposit mints the attested shares floored to share coin units; the remainder, under one
 * coin unit, stays in the vault's Tron account. A failed or unviable one re-mints the
 * surrendered underlying amount. Either mint goes to this wallet, which must be the
 * supplier's.
 *
 * @param context - The flow context
 * @param outcome - The attested outcome from {@link pollTronRespondBidirectional}
 */
export async function settleTronSupply(
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
    const share = vaultTronTokenConfig(state, state.tronLendShareToken);
    console.log(
      `Tron deposit executed: completeTronSupply mints ` +
        `${String(tronAttestedUnits(outcome.serializedOutput, share.factor))} share coin units ` +
        "to this wallet (the supplier)",
    );
  } else {
    console.log(
      `the MPC attested the Tron deposit as ${OutputKind[outcome.event.outputKind]}: ` +
        "completeTronSupply re-mints the surrendered underlying to this wallet (the supplier)",
    );
  }
  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = executed ? outcome.serializedOutput : new Uint8Array(32);
  // A fresh random mint nonce per settle: randomness HERE is what keeps the minted coin
  // unlinkable to the (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));
  const result = await context.vault.callTx.completeTronSupply(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeTronSupply settled in tx ${result.public.txId}`);
}

/** Options for {@link completeTronSupply}. */
export interface CompleteTronSupplyOptions {
  /** The Tron supply request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the Tron supply's attestation resolves, then settle it.
 *
 * @param context - The flow context
 * @param tron - The Tron context the deposit's receipt is read through
 * @param options - The request id to settle
 * @throws {Error} If no verifying attestation posts within the poll's deadline
 */
export async function completeTronSupply(
  context: VaultContext,
  tron: TronContext,
  options: CompleteTronSupplyOptions,
): Promise<void> {
  const outcome = await pollTronRespondBidirectional(context, tron, {
    requestId: options.requestId,
    requestsPath: VAULT_TRON_SUPPLY_REQUESTS_PATH,
    expectedOutput: TronExpectedOutput.Uint256,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  await settleTronSupply(context, outcome);
}
