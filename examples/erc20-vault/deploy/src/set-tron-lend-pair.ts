// `setTronLendPair`: the deployer pairs a listed Tron underlying with its listed ERC-4626
// share token, and names the smallest supply the vault admits, in underlying coin units.
// The circuit is one-shot, so a vault already holding the pair is left alone, and one
// holding another pair fails the run.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";
import { bytesToHex } from "@sig-net/midnight";
import { envOrUndefined, type WalletRegistry } from "@sig-net/midnight-contract-deploy";
import {
  type DeployedVaultContract,
  evmAddressBytes,
  readVaultLedger,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { resolveVaultContractAddress, withDeployerVault } from "./deployer-vault.ts";
import {
  resolveTronTokenFactors,
  tronTokenAddress,
  type TronTokenListings,
} from "./tron-targets.ts";

/** What a {@link setTronLendPairOnVaultContract} or {@link setTronLendPairOnVault} call did. */
export enum SetTronLendPairOutcome {
  /** The circuit ran and recorded the pair in this call. */
  Set = "set",
  /** The ledger already held the pair, so nothing was submitted. */
  AlreadySet = "already-set",
  /** The environment names no pair, so nothing was submitted. */
  NotConfigured = "not-configured",
}

/** The pair and minimum `setTronLendPair` records. */
export interface TronLendPair {
  /** The Tron underlying, in its 20-byte form as lowercased 0x hex. */
  readonly underlying: string;
  /** The ERC-4626 share token over it, in the same form. */
  readonly shareToken: string;
  /** The smallest supply the vault admits, in underlying coin units. */
  readonly minSupply: bigint;
  /**
   * The share token's factor, which `TRON_TOKEN_FACTORS` must name: at factor 1 by omission
   * an 18-decimal share token's shares overflow a coin above about 18 USDT
   * at jUSDTv2's rate, so most supplies could not settle.
   */
  readonly shareFactor: bigint;
}

const TRON_LEND_VARIABLES = [
  "TRON_LEND_UNDERLYING",
  "TRON_LEND_SHARE_TOKEN",
  "TRON_LEND_MIN_SUPPLY",
] as const;

const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Resolve the pair `TRON_LEND_UNDERLYING` and `TRON_LEND_SHARE_TOKEN` name (each a base58
 * Tron address or 20-byte hex) with the minimum `TRON_LEND_MIN_SUPPLY` gives in underlying
 * coin units, and the share token's factor from `TRON_TOKEN_FACTORS`. The three variables
 * are set together or not at all.
 *
 * @param env - The environment to read the three variables and `TRON_TOKEN_FACTORS` from.
 * @returns The pair, or `undefined` when none of the three is set.
 * @throws {Error} If only some are set, an address is malformed or zero, the two name one
 *   token, the minimum is not a positive integer that fits a Uint<64>, or
 *   `TRON_TOKEN_FACTORS` does not name the share token.
 */
export function resolveTronLendPair(
  env: Record<string, string | undefined>,
): TronLendPair | undefined {
  const underlying = envOrUndefined(env, "TRON_LEND_UNDERLYING");
  const shareToken = envOrUndefined(env, "TRON_LEND_SHARE_TOKEN");
  const minSupply = envOrUndefined(env, "TRON_LEND_MIN_SUPPLY");
  if (underlying === undefined && shareToken === undefined && minSupply === undefined) {
    return undefined;
  }
  if (underlying === undefined || shareToken === undefined || minSupply === undefined) {
    throw new Error(`${TRON_LEND_VARIABLES.join(", ")} name one pair, so set all three or none.`);
  }
  if (!/^[1-9]\d*$/.test(minSupply) || BigInt(minSupply) > UINT64_MAX) {
    throw new Error(
      `TRON_LEND_MIN_SUPPLY must be a positive integer that fits a Uint<64>, got "${minSupply}".`,
    );
  }
  const underlyingAddress = tronTokenAddress(underlying);
  const shareTokenAddress = tronTokenAddress(shareToken);
  for (const [name, token] of [
    ["TRON_LEND_UNDERLYING", underlyingAddress],
    ["TRON_LEND_SHARE_TOKEN", shareTokenAddress],
  ] as const) {
    if (evmAddressBytes(token).every((byte) => byte === 0)) {
      throw new Error(`${name} is the zero address, which the vault never pairs.`);
    }
  }
  if (underlyingAddress === shareTokenAddress) {
    throw new Error("TRON_LEND_UNDERLYING and TRON_LEND_SHARE_TOKEN name the same token.");
  }
  const shareFactor = resolveTronTokenFactors(env).get(shareTokenAddress);
  if (shareFactor === undefined) {
    throw new Error(
      `TRON_TOKEN_FACTORS must name TRON_LEND_SHARE_TOKEN ${shareTokenAddress}: its factor is ` +
        "fixed at listing, and at factor 1 an 18-decimal share token's larger supplies cannot settle.",
    );
  }
  return {
    underlying: underlyingAddress,
    shareToken: shareTokenAddress,
    minSupply: BigInt(minSupply),
    shareFactor,
  };
}

/**
 * Refuse a pair whose tokens this run's listing leaves out: a fresh deploy lists its
 * TRC-20s just before it records the pair, and the circuit refuses an unlisted token only
 * after the vault exists.
 *
 * @param pair - The pair the environment names, from {@link resolveTronLendPair}.
 * @param listings - The TRC-20s this run lists, from `resolveTronTokenListings`.
 * @throws {Error} If `listings` leaves out the pair's underlying or share token.
 */
export function assertTronLendPairListed(pair: TronLendPair, listings: TronTokenListings): void {
  for (const [name, token] of [
    ["TRON_LEND_UNDERLYING", pair.underlying],
    ["TRON_LEND_SHARE_TOKEN", pair.shareToken],
  ] as const) {
    if (!listings.has(token)) {
      throw new Error(`${name} ${token} is not in TRON_ALLOWED_TOKENS, so the pair cannot be set.`);
    }
  }
}

/**
 * Render a pair for a log line.
 *
 * @param pair - The pair to render.
 * @returns The underlying, the share token and the minimum supply.
 */
function formatTronLendPair(pair: TronLendPair): string {
  return (
    `${pair.underlying} -> ${pair.shareToken} (factor ${String(pair.shareFactor)}), ` +
    `min supply ${String(pair.minSupply)}`
  );
}

/**
 * Call the vault's `setTronLendPair` circuit with `pair`, unless the ledger already holds
 * it. Both tokens must already be listed: the circuit refuses an unlisted one, and the check
 * here fails before any call is submitted. The caller must hold the DEPLOYER identity.
 *
 * @param vault - The joined vault contract handle.
 * @param publicDataProvider - The provider to read the vault's current ledger state through.
 * @param vaultContractAddress - The vault contract's address (the state to read).
 * @param pair - The pair to record, from {@link resolveTronLendPair}.
 * @returns Whether this call recorded the pair or found it already recorded.
 * @throws {Error} If the vault is not initialised, holds another pair, does not list a token
 *   of `pair`, lists the share token at another factor than `pair.shareFactor` (a pair over
 *   it could never settle a supply as intended), or the circuit rejects the caller.
 */
export async function setTronLendPairOnVaultContract(
  vault: DeployedVaultContract,
  publicDataProvider: PublicDataProvider,
  vaultContractAddress: string,
  pair: TronLendPair,
): Promise<SetTronLendPairOutcome> {
  const state = await readVaultLedger(publicDataProvider, vaultContractAddress);
  if (!state.initialised) {
    throw new Error("the vault is not initialised: run `yarn initialise:erc20-vault` first");
  }
  if (!state.tronLendShareToken.every((byte) => byte === 0)) {
    const held: TronLendPair = {
      underlying: `0x${bytesToHex(state.tronLendUnderlying)}`,
      shareToken: `0x${bytesToHex(state.tronLendShareToken)}`,
      minSupply: state.tronLendMinSupply,
      shareFactor: state.allowedTronTokens.lookup(state.tronLendShareToken).factor,
    };
    if (formatTronLendPair(held) !== formatTronLendPair(pair)) {
      throw new Error(
        `the vault already pairs ${formatTronLendPair(held)}, and setTronLendPair is one-shot`,
      );
    }
    console.log(`Tron lend pair already ${formatTronLendPair(held)}, skipping`);
    return SetTronLendPairOutcome.AlreadySet;
  }
  for (const token of [pair.underlying, pair.shareToken]) {
    if (!state.allowedTronTokens.member(evmAddressBytes(token))) {
      throw new Error(
        `the vault does not allow TRC-20 ${token}: run \`yarn add-allowed-tron-tokens:erc20-vault\` first`,
      );
    }
  }
  const listedFactor = state.allowedTronTokens.lookup(evmAddressBytes(pair.shareToken)).factor;
  if (listedFactor !== pair.shareFactor) {
    throw new Error(
      `the vault lists share token ${pair.shareToken} at factor ${String(listedFactor)}, not ` +
        `the ${String(pair.shareFactor)} TRON_TOKEN_FACTORS names: the listing cannot change, ` +
        "so the pair is left unset",
    );
  }
  const result = await vault.callTx.setTronLendPair(
    evmAddressBytes(pair.underlying),
    evmAddressBytes(pair.shareToken),
    pair.minSupply,
  );
  console.log(`Tron lend pair set to ${formatTronLendPair(pair)} in tx ${result.public.txId}`);
  return SetTronLendPairOutcome.Set;
}

/**
 * Join a deployed vault as the deployer and record the Tron lend pair the environment
 * names: the standalone counterpart of {@link setTronLendPairOnVaultContract} for
 * entrypoints that hold no session. An environment naming no pair starts no wallet.
 *
 * @param env - The environment: the variables {@link resolveTronLendPair} reads and
 *   everything {@link withDeployerVault} reads. Defaults to `process.env`.
 * @param contractAddress - The vault to configure. Defaults to `MIDNIGHT_VAULT_CONTRACT_ADDRESS`.
 * @param wallets - A registry to take the deployer wallet from, when the caller keeps wallets
 *   open across steps. Without one the wallet is opened for this call and closed after it.
 * @returns What the call did.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT nor
 *   DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no contract address is available, a variable is malformed, or the call
 *   fails as {@link setTronLendPairOnVaultContract} does.
 */
export async function setTronLendPairOnVault(
  env: Record<string, string | undefined> = process.env,
  contractAddress?: string,
  wallets?: WalletRegistry,
): Promise<SetTronLendPairOutcome> {
  const vaultContractAddress = resolveVaultContractAddress(
    env,
    contractAddress,
    "pair a Tron lend underlying on",
  );
  const pair = resolveTronLendPair(env);
  if (pair === undefined) {
    console.log("TRON_LEND_SHARE_TOKEN names no Tron lend pair, nothing to set");
    return SetTronLendPairOutcome.NotConfigured;
  }
  return withDeployerVault(
    env,
    vaultContractAddress,
    "pairing a Tron lend underlying on",
    Object.fromEntries(TRON_LEND_VARIABLES.map((name) => [name, envOrUndefined(env, name)])),
    (vault, publicDataProvider) =>
      setTronLendPairOnVaultContract(vault, publicDataProvider, vaultContractAddress, pair),
    wallets,
  );
}
