// SeedWallet: a {@link Wallet} backed by a seed held in-app, over the
// wallet-sdk `WalletFacade`. The seed-to-facade construction below mirrors the
// Node-side wallet plumbing the example's flows use, rebuilt here because a
// browser cannot import the Node-only workspace packages.
//
// Same two-path lifecycle as BrowserWallet:
//   1. `const w = new SeedWallet(config, seed); await w.initialise();`
//   2. `const w = await SeedWallet.Initialise(config, seed);`
//
// The constructor only records its inputs (it is intentionally not async and
// does no work). Everything else (derive keys, build the facade, start it)
// happens in `initialise()`. Touching any other member before that throws.
//
// The facade syncs against the indexer from `start()` onwards; balance reads
// await the synced state, so the first read after installing can take a
// moment while the wallet catches up with the chain.
import "../../polyfills/buffer.ts";

import type { MidnightNodeConfig } from "@midnight-examples/chain-config";
import type { Signature, SignDataOptions } from "@midnight-ntwrk/dapp-connector-api";
import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import { type DustBalance, type Wallet, WalletError, WalletKind } from "./Wallet.ts";

/**
 * Base of every error this module raises, a {@link WalletError} so one
 * `instanceof` catches failures from either wallet kind.
 */
export class SeedWalletError extends WalletError {}

/** The seed input did not parse as a hex seed: see {@link SeedWallet}. */
export class SeedWalletParseError extends SeedWalletError {}

/** A member that needs a running facade was touched before {@link SeedWallet.initialise}. */
export class SeedWalletNotInitialisedError extends SeedWalletError {
  /**
   *
   */
  constructor() {
    super("SeedWallet is not initialised: call initialise() (or use SeedWallet.Initialise) first.");
  }
}

/**
 * Parse a hex seed (16–64 bytes, optional 0x prefix) into its bytes.
 *
 * @param input - The seed as supplied by the user.
 * @returns The seed bytes.
 * @throws {SeedWalletParseError} when the input is not hex of a valid length.
 */
function parseHexSeed(input: string): Uint8Array {
  const compact = input.trim().replace(/^0x/i, "");
  if (compact === "") {
    throw new SeedWalletParseError("Nothing to parse: paste a hex seed first.");
  }
  if (!/^[0-9a-fA-F]+$/.test(compact) || compact.length % 2 !== 0) {
    throw new SeedWalletParseError("The seed must be hex (an even number of 0-9a-f digits).");
  }
  const byteCount = compact.length / 2;
  if (byteCount < 16 || byteCount > 64) {
    throw new SeedWalletParseError(`A hex seed must be 16-64 bytes; got ${String(byteCount)}.`);
  }
  const bytes = new Uint8Array(byteCount);
  for (let index = 0; index < byteCount; index++) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// The live key material for one account, reused for signing and balancing.
interface AccountKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * Derive the three role keys (Zswap / NightExternal / Dust) from seed bytes.
 * Pure crypto, no network. This is the step that exercises the ledger WASM.
 *
 * @param seedBytes - The parsed seed, 16-64 bytes.
 * @param networkId - The network the derived addresses encode for.
 * @returns The derived key material.
 * @throws {Error} The ledger WASM's own error when the seed bytes fall
 *   outside what the HD derivation accepts.
 */
function deriveAccountKeys(seedBytes: Uint8Array, networkId: string): AccountKeys {
  const hd = HDWallet.fromSeed(seedBytes);
  if (hd.type !== "seedOk") throw new SeedWalletError("HDWallet.fromSeed failed (seedError).");

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") {
    throw new SeedWalletError("deriveKeysAt failed (keyOutOfBounds).");
  }
  hd.hdWallet.clear();

  return {
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(
      { kind: "schnorr", secret: derived.keys[Roles.NightExternal] },
      networkId,
    ),
  };
}

// The fee settings the facade balances transactions with: it burns
// `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead` per
// transaction. The overhead compensates for the wallet sdk pricing a
// PROOF-ERASED transaction while the node prices the real proof bytes; the
// vault's keccak-based attestation-verification proofs otherwise leave the
// node's fee above the wallet's estimate and the node rejects the spend with
// Malformed(BalanceCheckOverspend). Matches the Node-side wallet plumbing.
const COST_PARAMETERS = {
  additionalFeeOverhead: 50_000_000_000_000n,
  feeBlocksMargin: 5,
} as const;

/**
 * Wire up the WalletFacade for the given keys + connection config. This only
 * constructs the three sub-wallets; it does NOT start syncing.
 *
 * @param keys - The derived account keys the sub-wallets sign with.
 * @param config - The endpoints the facade connects to.
 * @returns The constructed (unstarted) facade.
 */
function initialiseWalletFacade(
  keys: AccountKeys,
  config: MidnightNodeConfig,
): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      provingServerUrl: new URL(config.proofServerUrl),
      // The facade talks to the node over WebSocket, so flip http(s) -> ws(s).
      relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
      costParameters: COST_PARAMETERS,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        WalletEntrySchema,
        mergeWalletEntries,
      ),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(
        keys.dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
}

// Recipes (balancing plans for submitted transactions) expire 30 min out.
const RECIPE_TTL_MS = 30 * 60 * 1000;

/**
 * Decode a connector-style `signData` payload into the bytes to sign.
 *
 * @param data - The payload string.
 * @param encoding - How the payload encodes those bytes.
 * @returns The decoded bytes ('text' is encoded as UTF-8, per the connector's
 *   own normalisation rule).
 * @throws {SeedWalletParseError} when the payload does not decode as claimed.
 */
function decodeSignableData(data: string, encoding: SignDataOptions["encoding"]): Uint8Array {
  switch (encoding) {
    case "text":
      return new TextEncoder().encode(data);
    case "hex": {
      const compact = data.replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]*$/.test(compact) || compact.length % 2 !== 0) {
        throw new SeedWalletParseError("signData payload is not valid hex.");
      }
      return Uint8Array.from((compact.match(/.{2}/g) ?? []).map((pair) => parseInt(pair, 16)));
    }
    case "base64": {
      try {
        return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      } catch {
        throw new SeedWalletParseError("signData payload is not valid base64.");
      }
    }
  }
}

// Everything that only exists once initialised.
interface Initialised {
  facade: WalletFacade;
  keys: AccountKeys;
}

/**
 *
 */
export class SeedWallet implements Wallet {
  readonly kind = WalletKind.Seed;
  readonly name = "Seed wallet";
  readonly iconUrl = undefined;
  /** A seed wallet has no service preferences of its own: it runs on the config it was given. */
  readonly configuration = null;

  /**
   * Build and start a SeedWallet in one call (does NOT wait for sync).
   *
   * @param config - The endpoints and network the wallet runs against.
   * @param seed - The hex seed, 16-64 bytes, 0x optional.
   * @returns The started wallet.
   */
  static async Initialise(config: MidnightNodeConfig, seed: string): Promise<SeedWallet> {
    const wallet = new SeedWallet(config, seed);
    await wallet.initialise();
    return wallet;
  }

  private readonly config: MidnightNodeConfig;
  private readonly seed: string;
  private initialised?: Initialised;
  // In-flight initialise, so concurrent / StrictMode-double calls share one
  // facade instead of racing two.
  private initialising?: Promise<void>;

  /**
   * @param config  midnight node config: the network the keys encode
   *                addresses for, and the stack the facade connects to
   * @param seed    the wallet seed as hex (16-64 bytes, 0x optional)
   */
  constructor(config: MidnightNodeConfig, seed: string) {
    this.config = config;
    this.seed = seed;
  }

  /**
   * Derive the account keys, construct the facade and start it. Resolves once
   * the facade is started (connections open, scanning begun); it does NOT wait
   * for the chain tip, which the balance reads do instead. Idempotent: a
   * second call is a no-op once started, and concurrent calls share the one
   * in-flight start.
   *
   * @returns Resolution once the facade is started (the shared in-flight
   *   promise when a start is already running).
   *
   * @throws {SeedWalletParseError} when the seed is not valid hex.
   * @throws {SeedWalletError} when key derivation fails, or whatever the
   *   facade start raises (an unreachable indexer or node surfaces here). A
   *   failed start stops the facade before rethrowing, so a half-started
   *   wallet never leaks its connections.
   */
  async initialise(): Promise<void> {
    if (this.initialised) return;
    if (this.initialising) return this.initialising;

    this.initialising = this.performInitialise().finally(() => {
      this.initialising = undefined;
    });
    return this.initialising;
  }

  private async performInitialise(): Promise<void> {
    const seedBytes = parseHexSeed(this.seed);
    const keys = deriveAccountKeys(seedBytes, this.config.networkId);
    const facade = await initialiseWalletFacade(keys, this.config);

    try {
      await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
    } catch (error) {
      await facade.stop().catch(() => {
        // Best-effort teardown: the start error below is the one to surface.
      });
      throw error;
    }

    this.initialised = { facade, keys };
  }

  /**
   * Guard for members that require {@link initialise} to have completed.
   *
   * @returns The initialised state.
   * @throws {SeedWalletNotInitialisedError} Before {@link initialise}.
   */
  private requireInitialised(): Initialised {
    if (!this.initialised) {
      throw new SeedWalletNotInitialisedError();
    }
    return this.initialised;
  }

  /**
   * Stop the facade: close its indexer and node connections and forget the
   * keys. A later {@link initialise} would build a fresh facade, but callers
   * are expected to construct a new wallet instead.
   */
  async disconnect(): Promise<void> {
    const initialised = this.initialised;
    this.initialised = undefined;
    if (initialised) {
      await initialised.facade.stop();
    }
  }

  /**
   * The wallet's unshielded (Night) receive address, as bech32m: stable per
   * seed and network, so the same seed scopes to the same storage and
   * queries across installs.
   *
   * @returns The bech32m unshielded address.
   */
  get id(): string {
    return this.requireInitialised().keys.unshieldedKeystore.getBech32Address().asString();
  }

  /**
   * The wallet's shielded coin public key.
   *
   * @returns The key, as the ledger's hex string.
   */
  getCoinPublicKey(): ledger.CoinPublicKey {
    return this.requireInitialised().keys.shieldedSecretKeys.coinPublicKey;
  }

  /**
   * The wallet's shielded encryption public key.
   *
   * @returns The key, as the ledger's hex string.
   */
  getEncryptionPublicKey(): ledger.EncPublicKey {
    return this.requireInitialised().keys.shieldedSecretKeys.encryptionPublicKey;
  }

  /**
   * Balance an unbound (proven, pre-binding) transaction: add the dust fee
   * inputs, sign them with the unshielded keystore, and prove the balancing
   * additions via the facade's configured proof server.
   *
   * @param tx - The transaction to balance.
   * @param ttl - When the balancing recipe expires; 30 minutes out when omitted.
   * @returns The finalized transaction, ready to {@link submitTx}.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}, or
   *   whatever the facade raises (insufficient dust, proving failure).
   */
  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<ledger.FinalizedTransaction> {
    const { facade, keys } = this.requireInitialised();
    const recipe = await facade.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
      { ttl: ttl ?? new Date(Date.now() + RECIPE_TTL_MS) },
    );
    const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
    return facade.finalizeRecipe(signed);
  }

  /**
   * Submit a finalized transaction to the network via the facade's node
   * connection.
   *
   * @param tx - The finalized transaction to submit.
   * @returns The transaction identifier of the submitted transaction.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}, or
   *   whatever the node rejects the transaction with.
   */
  async submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
    return this.requireInitialised().facade.submitTransaction(tx);
  }

  /**
   * The wallet's shielded token balances, read from the synced facade state.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}.
   */
  async getShieldedBalances(): Promise<Record<string, bigint>> {
    const state = await this.requireInitialised().facade.waitForSyncedState();
    return state.shielded.balances;
  }

  /**
   * The wallet's unshielded token balances, read from the synced facade
   * state.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}.
   */
  async getUnshieldedBalances(): Promise<Record<string, bigint>> {
    const state = await this.requireInitialised().facade.waitForSyncedState();
    return state.unshielded.balances;
  }

  /**
   * The wallet's spendable dust, read from the synced facade state. The
   * facade reports no generation cap, so `cap` is null.
   *
   * @returns The spendable balance, with a null cap.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}.
   */
  async getDustBalance(): Promise<DustBalance> {
    const state = await this.requireInitialised().facade.waitForSyncedState();
    return { balance: state.dust.balance(new Date()), cap: null };
  }

  /**
   * Sign `data` with the unshielded keystore, in-process and without a
   * prompt. The bytes signed are exactly the decoded `data`: this wallet
   * applies no domain prefix of its own.
   *
   * Determinism is the ledger keystore's choice, not promised here, so a
   * caller deriving anything from the signature must verify reproducibility
   * rather than assume it (the same caveat the browser wallet carries).
   *
   * @param data - The data to sign, encoded as `options.encoding` says.
   * @param options - The encoding of `data`; the key is always unshielded.
   * @returns The signature, with the signed data and verifying key.
   * @throws {SeedWalletNotInitialisedError} before {@link initialise}, or
   *   {SeedWalletParseError} when `data` does not decode as
   *   `options.encoding` claims.
   */
  signData(data: string, options: SignDataOptions): Promise<Signature> {
    const { keys } = this.requireInitialised();
    const signature = keys.unshieldedKeystore.signData(decodeSignableData(data, options.encoding));
    return Promise.resolve({
      data,
      signature: signature.value,
      verifyingKey: keys.unshieldedKeystore.getPublicKey().value,
    });
  }
}
