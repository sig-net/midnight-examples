// `setTronLendPair`: the deployer pairs a listed Tron underlying with its listed ERC-4626
// share token, once.
//
// The circuit call is the deploy package's `setTronLendPairOnVaultContract`, the same
// function the set-tron-lend-pair entrypoint runs. This flow is the session-shaped face of
// it.
import {
  setTronLendPairOnVaultContract,
  type SetTronLendPairOutcome,
  type TronLendPair,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Record `pair` unless the vault already holds it. The caller must be the DEPLOYER
 * identity.
 *
 * @param context - The flow context
 * @param pair - The pair and minimum supply to record
 * @returns Whether this call recorded the pair or found it already recorded
 * @throws {Error} If the vault is not initialised, holds another pair, does not list a token
 *   of `pair`, or the circuit rejects the caller
 */
export async function setTronLendPair(
  context: VaultContext,
  pair: TronLendPair,
): Promise<SetTronLendPairOutcome> {
  return setTronLendPairOnVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    pair,
  );
}
