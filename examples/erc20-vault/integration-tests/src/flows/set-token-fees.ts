// `setTokenFees`: the deployer reprices every allowed token, the call the
// scheduled repricing job makes.
//
// The circuit calls are the deploy package's `setTokenFeesOnVaultContract`,
// the same function the set-token-fees entrypoint runs. This flow is the
// session-shaped face of it, so the suites exercise the code the job depends on.

import type { TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";
import { setTokenFeesOnVaultContract } from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Reprice every allowed token whose fees differ from `fees`, with one
 * `setTokenFees` call per such token.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field, so
 * `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this call.
 *
 * @param context - The flow context.
 * @param fees - The fees every allowed token is repriced to.
 * @returns The ERC20s this call repriced, as 0x hex.
 * @throws {Error} If the vault is not initialised or the circuit rejects the caller.
 */
export async function setTokenFees(
  context: VaultContext,
  fees: TokenFees,
): Promise<readonly string[]> {
  return setTokenFeesOnVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    fees,
  );
}
