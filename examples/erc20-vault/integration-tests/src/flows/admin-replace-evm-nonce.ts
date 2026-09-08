// `adminReplaceEvmNonce`: record the deployer-gated break-glass request that
// replaces whatever the vault signed at one EVM nonce with an empty
// self-transfer. The vault signs from ONE account with a strictly sequential
// nonce, so a transaction that can never be included blocks every later one;
// broadcasting this replacement consumes the blocked nonce and the queue
// behind it moves again. Sign-only, like the approves: there is no settle
// circuit, so the round trip ends at the broadcast.

import {
  type RequestIdHex,
  SIGNET_DEFAULT_KEY_VERSION,
  toSignBidirectionalEventIndex,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

/**
 * The one request id present after a call and absent before it.
 *
 * This is how the flow finds the record its own call inserted, instead of
 * recomputing the request id off chain the way the approve and withdraw flows
 * do: a replacement carries NO calldata, and the `Maybe` an absent calldata
 * hashes as is a default-valued struct whose exact shape only the compiler
 * fixes, so a recomputed id would be a twin of that layout. The ledger's own
 * before/after is the fact itself.
 *
 * @param before - Request ids on the map before the call.
 * @param after - Request ids on the map after the call.
 * @returns The newly inserted request id.
 * @throws {Error} When the call inserted anything other than exactly one request.
 */
function soleNewRequestId(
  before: ReadonlySet<RequestIdHex>,
  after: Iterable<RequestIdHex>,
): RequestIdHex {
  const added = [...after].filter((requestId) => !before.has(requestId));
  const [requestId] = added;
  if (requestId === undefined || added.length !== 1) {
    throw new Error(
      `adminReplaceEvmNonce inserted ${String(added.length)} requests, expected exactly 1`,
    );
  }
  return requestId;
}

/**
 * Record the replacement request for `evmNonce` and return its id.
 *
 * The circuit is deployer-gated, so `context` must be joined as the deployer.
 * It takes its fee values from the ledger, so raise them with `setGasParams`
 * BEFORE calling this whenever the point is to outbid a transaction already
 * sitting in the mempool: a replacement only evicts the original if it pays
 * meaningfully more. Note that this CANCELS whatever sat at that nonce rather
 * than retrying it — the original request's record stays on the ledger
 * unsettled and its operation never happens.
 *
 * @param context - The flow context, joined as the deployer.
 * @param evmNonce - The stuck vault-account nonce to replace.
 * @returns The recorded request id.
 * @throws {Error} When the vault is not initialised, or the call did not
 *   insert exactly one request.
 */
export async function adminReplaceEvmNonce(
  context: VaultContext,
  evmNonce: bigint,
): Promise<RequestIdHex> {
  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }
  const idsBefore = new Set(toSignBidirectionalEventIndex(before.signBidirectionalEventMap).keys());

  const result = await context.vault.callTx.adminReplaceEvmNonce(
    evmNonce,
    SIGNET_DEFAULT_KEY_VERSION,
  );
  console.log(`adminReplaceEvmNonce(${String(evmNonce)}) finalized in tx ${result.public.txId}`);

  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  return soleNewRequestId(
    idsBefore,
    toSignBidirectionalEventIndex(after.signBidirectionalEventMap).keys(),
  );
}
