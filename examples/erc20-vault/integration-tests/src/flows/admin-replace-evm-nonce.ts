import {
  type RequestIdHex,
  SIGNET_DEFAULT_KEY_VERSION,
  toSignBidirectionalEventIndex,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";

import type { VaultContext } from "../vault-context.ts";

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
 * Records the empty replacement transaction for a stuck vault nonce.
 *
 * @param context - The flow context, joined as the deployer.
 * @param evmNonce - The stuck vault-account nonce to replace.
 * @returns The recorded request id.
 * @throws {Error} When the vault is not initialised, or the call did not insert exactly one request.
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
