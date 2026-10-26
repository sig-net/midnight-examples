// `setTokenFees`: the deployer's repricing of every allowed token to the fees
// the environment names, the call a scheduled off-chain job makes once it has
// recomputed the fees from current gas and token prices. A token already at
// those fees is left alone, so a rerun submits nothing.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import { bytesToHex } from "@sig-net/midnight";
import {
  type DeployedVaultContract,
  readVaultLedger,
  type TokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import { formatTokenFees, resolveTokenFees } from "./fee-config.ts";

// Two fee structs holding the same figure for every action.
function sameFees(a: TokenFees, b: TokenFees): boolean {
  return (
    a.withdraw === b.withdraw && a.swap === b.swap && a.supply === b.supply && a.redeem === b.redeem
  );
}

/**
 * Call the vault's `setTokenFees` circuit for every allowed token whose fees differ
 * from `fees`, so a rerun against a vault already at those fees submits nothing.
 *
 * The caller must hold the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param fees - The fees every allowed token is repriced to, from {@link resolveTokenFees}.
 * @returns The ERC20s this call repriced, as 0x hex, in ledger order.
 * @throws {Error} If the vault is not initialised or the circuit rejects the caller.
 */
export async function setTokenFeesOnVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  fees: TokenFees,
): Promise<readonly string[]> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  const repriced: string[] = [];
  for (const [tokenBytes, config] of state.allowedTokens) {
    const token = `0x${bytesToHex(tokenBytes)}`;
    if (sameFees(config.fees, fees)) {
      console.log(`ERC20 ${token} already charges ${formatTokenFees(fees)}, skipping`);
      continue;
    }
    const result = await vault.callTx.setTokenFees(tokenBytes, fees);
    console.log(`repriced ERC20 ${token} to ${formatTokenFees(fees)} in tx ${result.public.txId}`);
    repriced.push(token);
  }
  return repriced;
}

/**
 * Join a deployed vault as the deployer and reprice every allowed token to the
 * fees {@link resolveTokenFees} reads: the standalone counterpart of
 * {@link setTokenFeesOnVaultContract} for entrypoints that hold no session.
 *
 * @param env - The environment: the fee variables and everything {@link withDeployerVault}
 *   reads. Defaults to `process.env`.
 * @param contractAddress - The vault to reprice. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @returns The ERC20s this call repriced.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no contract address is available, a fee variable is malformed, the
 *   vault is not initialised, or the circuit rejects the caller.
 */
export async function setTokenFeesOnVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
): Promise<readonly string[]> {
  const vaultContractAddress = resolveVaultContractAddress(env, contractAddress, "reprice");
  const fees = resolveTokenFees(env);
  return withDeployerVault(env, vaultContractAddress, (vault, publicDataProvider) =>
    setTokenFeesOnVaultContract(vault, publicDataProvider, vaultContractAddress, fees),
  );
}
