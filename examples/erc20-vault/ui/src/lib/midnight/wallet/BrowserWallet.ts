// BrowserWallet: a {@link Wallet} backed by a connected browser-extension
// wallet (e.g. Lace Midnight), via the dapp-connector API injected at
// `window.midnight`.
//
// Importing `@midnight-ntwrk/dapp-connector-api` also pulls in its global
// augmentation, so `window.midnight?.<key>` is typed as `InitialAPI`.
//
// Discovery, NOT a fixed key. Wallets inject their `InitialAPI` under an opaque,
// per-install key (Lace 4.x uses a random UUID, e.g.
// `window.midnight["36e95c3a-…"]`, compatible with the CAIP-372 draft), so there
// is no stable string to hardcode. {@link BrowserWallet.available} enumerates the
// injected wallets; the caller picks one and passes its `walletKey` to connect.
//
// Same two-path lifecycle as SeedWallet:
//   1. `const w = new BrowserWallet(config, key); await w.connect();`
//   2. `const w = await BrowserWallet.Connect(config, key);`
//
// The constructor only records which injected wallet to use; the actual
// connection (and the identity/config reads it needs) happen in `connect()`.
// Touching any other member before that throws.
//
// The connector is pull-based: there is no live state stream (unlike the seed
// facade's `Observable`), so balances / history / connection status are read on
// demand via the `get…` methods below.
import type { MidnightNodeConfig } from "@midnight-examples/chain-config";
import type {
  Configuration,
  ConnectedAPI,
  HistoryEntry,
  InitialAPI,
  Signature,
  SignDataOptions,
} from "@midnight-ntwrk/dapp-connector-api";
import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type * as ledger from "@midnightntwrk/ledger-v9";

import { type DustBalance, type Wallet, WalletError, WalletKind } from "./Wallet.ts";

/**
 * An injected wallet's self-description (`rdns`, `name`, `icon`, `apiVersion`,
 * each documented on the connector's `InitialAPI`), plus the `window.midnight`
 * key it was found under: the key to hand to {@link BrowserWallet.Connect}.
 *
 * Derived from `InitialAPI` rather than restated, so a field the connector adds
 * arrives here for free. `connect` is dropped deliberately: connecting goes
 * through {@link BrowserWallet}, which is what makes it concurrency-safe and
 * network-checked.
 *
 * `name` and `icon` come from the extension, so render them defensively: the
 * name as a text node and the icon as an `img` source, never as markup.
 */
export type BrowserWalletInfo = Omit<InitialAPI, "connect"> & {
  readonly walletKey: string;
};

/**
 * Base of every error this module raises, a {@link WalletError} so one
 * `instanceof` catches failures from either wallet kind.
 */
export class BrowserWalletError extends WalletError {}

/** Nothing is injected under the `window.midnight` key the wallet was built with. */
export class BrowserWalletNotInjectedError extends BrowserWalletError {
  /**
   * @param walletKey - The `window.midnight` key nothing was found under.
   */
  constructor(readonly walletKey: string) {
    super(
      `No Midnight wallet injected at window.midnight.${walletKey}: is the extension installed and enabled?`,
    );
  }
}

/**
 * The wallet connected, but on a different network than the app runs against.
 *
 * The network id passed to `connect` is only a HINT: the wallet is free to
 * connect on whichever network it is currently set to, so the network in hand is
 * only known once `getConfiguration` has been read back. Rejecting here is what
 * keeps a mismatch a failed connection, rather than reads against one network
 * and signatures produced for another.
 */
export class BrowserWalletNetworkMismatchError extends BrowserWalletError {
  /**
   * @param walletName - The wallet's own display name, for the message.
   * @param walletNetworkId - The network the wallet actually connected on.
   * @param appNetworkId - The network this app runs against.
   */
  constructor(
    readonly walletName: string,
    readonly walletNetworkId: string,
    readonly appNetworkId: string,
  ) {
    super(
      `Wallet ${walletName} connected on network "${walletNetworkId}", but this app runs against "${appNetworkId}": switch the wallet's network and connect again.`,
    );
  }
}

/** A member that needs a live connection was touched before {@link BrowserWallet.connect}. */
export class BrowserWalletNotConnectedError extends BrowserWalletError {
  /** The message is fixed: the failing member is visible in the stack. */
  constructor() {
    super("BrowserWallet is not connected: call connect() (or use BrowserWallet.Connect) first.");
  }
}

// Everything that only exists once connected.
interface Connected {
  api: ConnectedAPI;
  info: BrowserWalletInfo;
  // Read back at connect time to check the network, and kept: the URIs in it
  // are the wallet user's own service preferences.
  configuration: Configuration;
  // Read once at connect time and kept: the connector call is async, but the
  // WalletProvider interface reads the keys synchronously, so they have to be
  // in hand before the wallet is published as connected.
  shieldedAddresses: Awaited<ReturnType<ConnectedAPI["getShieldedAddresses"]>>;
}

/**
 * A {@link Wallet} over a dapp-connector browser extension: construction
 * records which injected wallet to use, {@link connect} performs the actual
 * connection, and every other member requires it to have completed.
 */
export class BrowserWallet implements Wallet {
  readonly kind = WalletKind.Browser;

  /**
   * Connect to the injected wallet identified by `walletKey` in one call.
   *
   * @param config - The node config whose network id the wallet is held to.
   * @param walletKey - The `window.midnight` key, from {@link available}.
   * @returns The connected wallet.
   */
  static async Connect(config: MidnightNodeConfig, walletKey: string): Promise<BrowserWallet> {
    const wallet = new BrowserWallet(config, walletKey);
    await wallet.connect();
    return wallet;
  }

  /**
   * Enumerate the wallets currently injected under `window.midnight`, each with
   * the key needed to {@link Connect} it. Empty when no extension is installed /
   * enabled. A single extension may inject more than one entry (e.g. multiple
   * API versions), so callers should let the user pick when more than one is
   * returned.
   *
   * @returns The injected wallets' self-descriptions, with their keys.
   */
  static available(): BrowserWalletInfo[] {
    if (typeof window === "undefined" || !window.midnight) return [];
    return Object.entries(window.midnight).map(([walletKey, injected]) => {
      // Everything the wallet says about itself, minus the connect call this
      // class owns. Spread rather than listed field by field, so this keeps
      // compiling and keeps carrying everything if the connector grows a field.
      const { connect: _connect, ...selfDescription } = injected;
      return { walletKey, ...selfDescription };
    });
  }

  private readonly config: MidnightNodeConfig;
  private readonly walletKey: string;
  private connected?: Connected;
  // In-flight connect, so concurrent / StrictMode-double calls share one prompt
  // instead of racing two `injected.connect()` calls.
  private connecting?: Promise<void>;

  /**
   * @param config     midnight node config; `config.networkId` is passed to the wallet as
   *                   the desired-network hint on connect, and is the network the
   *                   connected wallet is then held to
   * @param walletKey  the `window.midnight` key of the injected wallet to use:
   *                   an opaque per-install id, obtained from {@link available}
   *                   (never hardcoded; see the file header)
   */
  constructor(config: MidnightNodeConfig, walletKey: string) {
    this.config = config;
    this.walletKey = walletKey;
  }

  /**
   * Balance a transaction. Present to satisfy the WalletProvider interface
   * shape; the dapp-connector wallet balances inside the extension, so this
   * slot is never called.
   *
   * @param _tx - The transaction to balance.
   * @param _ttl - How long the balanced transaction stays valid.
   * @throws {Error} Always.
   */
  balanceTx(_tx: UnboundTransaction, _ttl?: Date): Promise<ledger.FinalizedTransaction> {
    throw new Error("Method not implemented.");
  }

  /**
   * The wallet's shielded coin public key, as the Bech32m string the
   * connector reports (`ledger.CoinPublicKey` is a bare `string`).
   *
   * Consumed today only as an account-scoping identifier by the private
   * state provider, which any stable string satisfies. If a consumer that
   * needs the raw-hex form ever arrives (the SDK's call-tx path, once
   * {@link balanceTx} is implemented), decode through
   * `@midnightntwrk/wallet-sdk-address-format` at that point.
   *
   * @returns The Bech32m-encoded coin public key.
   * @throws {BrowserWalletNotConnectedError} Before {@link connect}.
   */
  getCoinPublicKey(): ledger.CoinPublicKey {
    return this.requireConnected().shieldedAddresses.shieldedCoinPublicKey;
  }

  /**
   * The wallet's shielded encryption public key, as the Bech32m string the
   * connector reports. Same format caveat as {@link getCoinPublicKey}.
   *
   * @returns The Bech32m-encoded encryption public key.
   * @throws {BrowserWalletNotConnectedError} Before {@link connect}.
   */
  getEncryptionPublicKey(): ledger.EncPublicKey {
    return this.requireConnected().shieldedAddresses.shieldedEncryptionPublicKey;
  }

  /**
   * Submit a transaction to the network. Present to satisfy the
   * MidnightProvider interface shape; the dapp-connector wallet submits
   * inside the extension, so this slot is never called.
   *
   * @param _tx - The finalized transaction to submit.
   * @throws {Error} Always.
   */
  submitTx(_tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
    throw new Error("Method not implemented.");
  }

  /**
   * Connect to the injected wallet, confirm it came back on the app's network,
   * and cache its identity + config. Idempotent: a second call is a no-op once
   * connected, and concurrent calls share the one in-flight connection.
   *
   * @throws {BrowserWalletNotInjectedError} if nothing is injected under the
   *   wallet's key.
   * @throws {BrowserWalletNetworkMismatchError} if the wallet connected on a
   *   different network than the app runs against. Only the network id is
   *   compared: the wallet's indexer / node / prover URIs are its user's own
   *   preference and may legitimately differ from the app's while addressing
   *   the same network, so a difference there is not an error.
   * @throws {Error} The connector's own `APIError` (`code: 'Rejected'`) when
   *   the user declines the prompt, propagated untouched so the caller
   *   decides how to surface a cancellation.
   * @returns Resolution once the connection is established (the shared
   *   in-flight promise when a connect is already running).
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.performConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async performConnect(): Promise<void> {
    const injected = typeof window !== "undefined" ? window.midnight?.[this.walletKey] : undefined;
    if (!injected) {
      throw new BrowserWalletNotInjectedError(this.walletKey);
    }

    const api = await injected.connect(this.config.networkId);
    const configuration = await api.getConfiguration();
    if (configuration.networkId !== this.config.networkId) {
      throw new BrowserWalletNetworkMismatchError(
        injected.name,
        configuration.networkId,
        this.config.networkId,
      );
    }
    const shieldedAddresses = await api.getShieldedAddresses();

    const { connect: _connect, ...selfDescription } = injected;
    this.connected = {
      api,
      info: { walletKey: this.walletKey, ...selfDescription },
      configuration,
      shieldedAddresses,
    };
  }

  /**
   * Forget the connection, so a later {@link connect} prompts again.
   *
   * The connector API has no disconnect call, so this drops this object's
   * reference and nothing more: the extension still regards the site as
   * connected, and reconnecting may well not prompt the user again.
   *
   * @returns A resolved promise: the drop is synchronous, and the Promise
   *   shape is the {@link Wallet} contract.
   */
  disconnect(): Promise<void> {
    this.connected = undefined;
    return Promise.resolve();
  }

  /**
   * Whether {@link connect} has completed and not been {@link disconnect}ed
   * since.
   *
   * @returns True while connected.
   */
  get isConnected(): boolean {
    return this.connected !== undefined;
  }

  /**
   * Guard for members that require {@link connect} to have completed.
   *
   * @returns The connected state.
   * @throws {BrowserWalletNotConnectedError} Before {@link connect}.
   */
  private requireConnected(): Connected {
    if (!this.connected) {
      throw new BrowserWalletNotConnectedError();
    }
    return this.connected;
  }

  /**
   * The `window.midnight` key the wallet was connected through: stable per
   * extension install, so reconnecting the same extension scopes to the
   * same storage and queries.
   *
   * @returns The wallet's `window.midnight` key.
   */
  get id(): string {
    return this.requireConnected().info.walletKey;
  }

  /**
   * The extension's own display name.
   *
   * @returns The name, rendered as a text node only (extension-controlled).
   */
  get name(): string {
    return this.requireConnected().info.name;
  }

  /**
   * The extension's own icon.
   *
   * @returns The icon as a URL or data URL, used only as an `img` source.
   */
  get iconUrl(): string | undefined {
    return this.requireConnected().info.icon;
  }

  /**
   * The injected wallet's self-description.
   *
   * @returns The key, rdns, name, icon and API version, as injected.
   */
  get info(): BrowserWalletInfo {
    return this.requireConnected().info;
  }

  /**
   * The services the wallet itself uses (indexer, node, prover URIs), read at
   * connect time. Its user's own preference, which the connector docs ask dapps
   * to honour where they can; its `networkId` is the app's, since a connection
   * on any other network is refused.
   *
   * @returns The wallet's own service configuration.
   */
  get configuration(): Configuration {
    return this.requireConnected().configuration;
  }

  /**
   * A page of the wallet's transaction history.
   *
   * @param pageNumber - Which page, 0-indexed.
   * @param pageSize - How many entries per page.
   * @returns The page's entries, newest first as the connector orders them.
   * @throws {BrowserWalletNotConnectedError} Before {@link connect}.
   */
  async getTxHistory(pageNumber: number, pageSize: number): Promise<HistoryEntry[]> {
    return this.requireConnected().api.getTxHistory(pageNumber, pageSize);
  }

  /**
   * The wallet's shielded token balances, keyed by token type, in atomic
   * units. A token type is opaque: the wallet carries no name, symbol or
   * decimals for it, and neither does anything downstream of this.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   * @throws {BrowserWalletNotConnectedError} before {@link connect}.
   */
  async getShieldedBalances(): Promise<Record<string, bigint>> {
    return this.requireConnected().api.getShieldedBalances();
  }

  /**
   * The wallet's unshielded token balances (Night among them), keyed by
   * token type, in atomic units. Same opacity as
   * {@link getShieldedBalances}.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   * @throws {BrowserWalletNotConnectedError} before {@link connect}.
   */
  async getUnshieldedBalances(): Promise<Record<string, bigint>> {
    return this.requireConnected().api.getUnshieldedBalances();
  }

  /**
   * The wallet's dust, with the cap the connector reports alongside it.
   *
   * @returns The spendable balance and the cap, in atomic units.
   * @throws {BrowserWalletNotConnectedError} before {@link connect}.
   */
  async getDustBalance(): Promise<DustBalance> {
    return this.requireConnected().api.getDustBalance();
  }

  /**
   * Ask the wallet to sign `data` with the key named in `options`, raising
   * its signing prompt.
   *
   * The connector's types promise nothing about determinism: whether the
   * same data and key produce the same signature twice is the WALLET
   * implementation's choice, so a caller deriving anything from the
   * signature must verify reproducibility rather than assume it.
   *
   * @param data - The data to sign, encoded as `options.encoding` says.
   * @param options - The encoding of `data` and which key signs.
   * @returns The signature, with the signed data and verifying key.
   * @throws {BrowserWalletNotConnectedError} before {@link connect}, or the
   *   connector's own `APIError` (`code: 'Rejected'`) when the user declines
   *   the signing prompt, propagated untouched.
   */
  async signData(data: string, options: SignDataOptions): Promise<Signature> {
    return this.requireConnected().api.signData(data, options);
  }
}
