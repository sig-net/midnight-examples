// The fee configuration a deployment seals at initialise and stamps on every
// ERC20 it allows: one flat fee per action for every token, and the wallet the
// fee coins are minted to. Repricing a token after bring-up is the deployer's
// `setTokenFees` call.

import type { CoinPublicKey, EncPublicKey } from "@midnightntwrk/ledger-v9";
import {
  deriveAccountKeys,
  envOrUndefined,
  getDeployConfig,
} from "@sig-net/midnight-contract-deploy";
import type { TokenFees } from "@sig-net/midnight-examples-erc20-vault-contract";

/** The wallet every fee coin is minted to, as the contract and midnight-js carry its keys. */
export interface FeeRecipientKeys {
  /** The Zswap coin public key the fee coins are committed to (32-byte hex). */
  readonly coinPublicKey: CoinPublicKey;
  /** The encryption public key clients encrypt the fee coin's ciphertext to (32-byte hex). */
  readonly encryptionPublicKey: EncPublicKey;
}

/**
 * The fee every action charges when its variable is unset, in the token's base
 * units: a visible charge on the local stack, far below any real gas cost.
 */
export const DEFAULT_TOKEN_FEE = 1000n;

const UINT64_MAX = 18446744073709551615n;

// A fee variable: a non-negative integer that fits the circuit's Uint<64>.
function resolveFee(env: Record<string, string | undefined>, name: string): bigint {
  const value = envOrUndefined(env, name);
  if (value === undefined) return DEFAULT_TOKEN_FEE;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer in token base units, got "${value}".`);
  }
  const fee = BigInt(value);
  if (fee > UINT64_MAX) {
    throw new Error(`${name} must fit a Uint<64>, got ${value}.`);
  }
  return fee;
}

/**
 * Resolve the flat per-action fees a deployment stamps on every token it
 * allows, from `VAULT_FEE_WITHDRAW`, `VAULT_FEE_SWAP`, `VAULT_FEE_SUPPLY` and
 * `VAULT_FEE_REDEEM`, each in the token's base units and defaulting to
 * {@link DEFAULT_TOKEN_FEE}. One `TokenFees` serves every token at bring-up: a
 * token whose decimals or price call for another figure is repriced with the
 * deployer's `setTokenFees` circuit.
 *
 * @param env - The environment to read the four variables from.
 * @returns The fees, in circuit argument shape.
 * @throws {Error} If a set variable is not a non-negative integer that fits a Uint<64>.
 */
export function resolveTokenFees(env: Record<string, string | undefined>): TokenFees {
  return {
    withdraw: resolveFee(env, "VAULT_FEE_WITHDRAW"),
    swap: resolveFee(env, "VAULT_FEE_SWAP"),
    supply: resolveFee(env, "VAULT_FEE_SUPPLY"),
    redeem: resolveFee(env, "VAULT_FEE_REDEEM"),
  };
}

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the wallet the fee coins are minted to: the pair
 * `VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY` / `VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY`
 * when set, else the deployer wallet's own shielded keys, derived from
 * `DEPLOYER_SEED` for the run's network. The two keys belong to one wallet, so
 * they are set together or not at all.
 *
 * @param env - The environment to read the pair, or the deployer seed and network, from.
 * @returns The recipient's coin and encryption public keys.
 * @throws {Error} If only one of the pair is set, or a set key is not 32 bytes of hex.
 */
export function resolveFeeRecipient(env: Record<string, string | undefined>): FeeRecipientKeys {
  const coinPublicKey = envOrUndefined(env, "VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY");
  const encryptionPublicKey = envOrUndefined(env, "VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY");
  if (coinPublicKey === undefined && encryptionPublicKey === undefined) {
    const deployConfig = getDeployConfig(env);
    const { shieldedSecretKeys } = deriveAccountKeys(
      deployConfig.deployerSeed,
      deployConfig.midnightNodeConfig.networkId,
    );
    return {
      coinPublicKey: shieldedSecretKeys.coinPublicKey,
      encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
    };
  }
  if (coinPublicKey === undefined || encryptionPublicKey === undefined) {
    throw new Error(
      "VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY and VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY name " +
        "one wallet, so set both or neither.",
    );
  }
  for (const [name, value] of [
    ["VAULT_FEE_RECIPIENT_COIN_PUBLIC_KEY", coinPublicKey],
    ["VAULT_FEE_RECIPIENT_ENCRYPTION_PUBLIC_KEY", encryptionPublicKey],
  ] as const) {
    if (!KEY_HEX.test(value)) {
      throw new Error(`${name} must be 32 bytes of hex, got "${value}".`);
    }
  }
  return {
    coinPublicKey: coinPublicKey.toLowerCase(),
    encryptionPublicKey: encryptionPublicKey.toLowerCase(),
  };
}

/**
 * Render fees for a log line.
 *
 * @param fees - The fees to render.
 * @returns One line naming each action's fee in base units.
 */
export function formatTokenFees(fees: TokenFees): string {
  return (
    `withdraw ${String(fees.withdraw)}, swap ${String(fees.swap)}, ` +
    `supply ${String(fees.supply)}, redeem ${String(fees.redeem)}`
  );
}
