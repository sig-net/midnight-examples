// `setTokenFees`: the deployer reprices the allowed tokens it names, the call
// the scheduled repricing job makes.
//
// The circuit calls are the deploy package's `setTokenFeesOnVaultContract`,
// the same function the set-token-fees entrypoint runs. This flow is the
// session-shaped face of it, so the suites exercise the code the job depends on.

import {
  setTokenFeesOnVaultContract,
  type TokenFeesByToken,
} from "@sig-net/midnight-examples-erc20-vault-deploy";

import type { VaultContext } from "../vault-context.ts";

/**
 * Reprice each of `tokens` whose ledger fees differ from the ones given, with
 * one `setTokenFees` call per such token.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field, so
 * `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this call.
 *
 * @param context - The flow context.
 * @param tokens - Each allowed ERC20 to reprice with its new fees.
 * @returns The ERC20s this call repriced, as lowercased 0x hex.
 * @throws {Error} If the vault is not initialised, a token is not allowed, or the circuit
 *   rejects the caller.
 */
export async function setTokenFees(
  context: VaultContext,
  tokens: TokenFeesByToken,
): Promise<readonly string[]> {
  return setTokenFeesOnVaultContract(
    context.vault,
    context.providers.publicDataProvider,
    context.vaultContractAddress,
    tokens,
  );
}
