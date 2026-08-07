// BrowserWallet: a {@link Wallet} backed by a connected browser-extension
// wallet (e.g. MetaMask), via the EIP-1193 provider the extension announces
// under EIP-6963.
//
// Discovery, NOT `window.ethereum`. Extensions announce themselves by
// dispatching an `eip6963:announceProvider` event, once on page load and again
// whenever an `eip6963:requestProvider` event asks, so several wallets can
// coexist without fighting over one global. {@link BrowserWallet.available}
// snapshots the announced wallets; the caller picks one and passes its `rdns`
// to connect.
//
// Same two-path lifecycle as SeedWallet:
//   1. `const w = new BrowserWallet(config, rdns); await w.connect();`
//   2. `const w = await BrowserWallet.Connect(config, rdns);`
//
// The constructor only records which announced wallet to use; the actual
// connection (the account request and the chain check) happens in `connect()`.
// Touching any other member before that throws.
import type { EvmChainConfig } from "@midnight-examples/chain-config";
import {
  type Address,
  createWalletClient,
  custom,
  type EIP1193Provider,
  getAddress,
  hexToNumber,
  numberToHex,
} from "viem";

import { toViemChain } from "../chain.ts";
import { type EvmWalletClient, type Wallet, WalletError, WalletKind } from "./Wallet.ts";

// EIP-6963's announcement payload. viem types the EIP-1193 provider but not
// the discovery protocol around it, so the two record shapes live here.
interface Eip6963ProviderInfo {
  /** Per-page-load id, regenerated every session: NOT a stable handle. */
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  /** Reverse-DNS id of the extension, stable per install across page loads. */
  readonly rdns: string;
}

// One announced wallet: its self-description and the provider to talk to it.
interface Eip6963ProviderDetail {
  readonly info: Eip6963ProviderInfo;
  readonly provider: EIP1193Provider;
}

/**
 * An announced wallet's self-description, as much of it as a picker needs:
 * `rdns` is the handle to hand to {@link BrowserWallet.Connect} (stable per
 * extension install, unlike the per-session `uuid`), `name` and `icon` are
 * what the user recognises.
 *
 * `name` and `icon` come from the extension, so render them defensively: the
 * name as a text node and the icon as an `img` source, never as markup.
 */
export type BrowserWalletInfo = Pick<Eip6963ProviderInfo, "rdns" | "name" | "icon">;

/**
 * Base of every error this module raises, a {@link WalletError} so one
 * `instanceof` catches failures from either wallet kind.
 */
export class BrowserWalletError extends WalletError {}

/** No wallet is announced under the `rdns` the wallet was built with. */
export class BrowserWalletNotAnnouncedError extends BrowserWalletError {
  /**
   * @param rdns - The EIP-6963 rdns nothing was announced under.
   */
  constructor(readonly rdns: string) {
    super(`No EVM wallet announced under ${rdns}: is the extension installed and enabled?`);
  }
}

/**
 * The wallet connected, but on a different chain than the app runs against.
 *
 * A wallet connects on whichever chain it is currently set to, and a
 * `wallet_switchEthereumChain` request is only a request: the wallet (or its
 * user) is free to refuse it. Rejecting here is what keeps a mismatch a failed
 * connection, rather than balances read against one chain and transactions
 * signed for another.
 */
export class BrowserWalletChainMismatchError extends BrowserWalletError {
  /**
   * @param walletName - The wallet's own display name, for the message.
   * @param walletChainId - The chain the wallet is actually on.
   * @param appChainId - The chain this app runs against.
   */
  constructor(
    readonly walletName: string,
    readonly walletChainId: number,
    readonly appChainId: number,
  ) {
    super(
      `Wallet ${walletName} connected to chain ${String(walletChainId)}, but this app runs against chain ${String(appChainId)}: switch the wallet's network and connect again.`,
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

/**
 * Snapshot the wallets currently announced under EIP-6963: listen, ask, and
 * unlisten in one tick. The spec requires providers to answer a
 * `requestProvider` event synchronously, so the snapshot is complete by the
 * time the listener is removed; a wallet announcing late (or never answering
 * a request) only shows up on a later snapshot.
 *
 * @returns The announced wallets, first announcement per rdns.
 */
function discoverProviders(): Eip6963ProviderDetail[] {
  if (typeof window === "undefined") return [];
  const announced: Eip6963ProviderDetail[] = [];
  const collect = (event: Event): void => {
    const { detail } = event as CustomEvent<Eip6963ProviderDetail>;
    // An extension may announce more than once (on load and per request):
    // the rdns is its identity, so keep the first announcement per rdns.
    if (!announced.some((existing) => existing.info.rdns === detail.info.rdns)) {
      announced.push(detail);
    }
  };
  window.addEventListener("eip6963:announceProvider", collect);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.removeEventListener("eip6963:announceProvider", collect);
  return announced;
}

// Everything that only exists once connected.
interface Connected {
  info: Eip6963ProviderInfo;
  provider: EIP1193Provider;
  account: Address;
  client: EvmWalletClient;
  // The handler subscribed to the provider's session events, kept so
  // disconnect() can unsubscribe the exact same reference.
  onSessionEvent: () => void;
}

/**
 * A {@link Wallet} over an EIP-6963 announced extension: construction
 * records which announced wallet to use, {@link connect} performs the
 * account request and chain check, and every other member requires it to
 * have completed.
 */
export class BrowserWallet implements Wallet {
  readonly kind = WalletKind.Browser;

  /**
   * Connect to the wallet announced under `rdns` in one call.
   *
   * @param config - The EVM chain the wallet must come back on.
   * @param rdns - The EIP-6963 rdns, from {@link available}.
   * @param onSessionChanged - Stale-session callback; see the constructor.
   * @returns The connected wallet.
   */
  static async Connect(
    config: EvmChainConfig,
    rdns: string,
    onSessionChanged?: () => void,
  ): Promise<BrowserWallet> {
    const wallet = new BrowserWallet(config, rdns, onSessionChanged);
    await wallet.connect();
    return wallet;
  }

  /**
   * Snapshot the wallets currently announced under EIP-6963, each with the
   * `rdns` needed to {@link Connect} it. Empty when no extension is
   * installed and enabled. Point-in-time, not reactive: an extension that
   * announces late only shows up on a later call.
   *
   * @returns The announced wallets' self-descriptions, with their rdns.
   */
  static available(): BrowserWalletInfo[] {
    return discoverProviders().map(({ info }) => ({
      rdns: info.rdns,
      name: info.name,
      icon: info.icon,
    }));
  }

  private readonly config: EvmChainConfig;
  private readonly rdns: string;
  private readonly onSessionChanged?: () => void;
  private connected?: Connected;
  // In-flight connect, so concurrent / StrictMode-double calls share one
  // prompt instead of racing two `eth_requestAccounts` calls.
  private connecting?: Promise<void>;

  /**
   * @param config            the EVM chain the wallet must come back on: its
   *                          chain id is requested at connect and then enforced
   * @param rdns              the EIP-6963 rdns of the announced wallet to use,
   *                          obtained from {@link available}
   * @param onSessionChanged  called when the provider reports a changed
   *                          account or chain after connecting. Firing means
   *                          the connection this object was published with is
   *                          stale, so the holder should discard the wallet.
   */
  constructor(config: EvmChainConfig, rdns: string, onSessionChanged?: () => void) {
    this.config = config;
    this.rdns = rdns;
    this.onSessionChanged = onSessionChanged;
  }

  /**
   * Connect to the announced wallet, confirm it came back on the app's
   * chain, and cache its identity and client. Idempotent: a second call is a
   * no-op once connected, and concurrent calls share the one in-flight
   * connection.
   *
   * @throws {BrowserWalletNotAnnouncedError} if nothing is announced under
   *   the wallet's rdns.
   * @throws {BrowserWalletChainMismatchError} if the wallet is on a
   *   different chain and declined to switch to the app's.
   * @throws {Error} The provider's own EIP-1193 error (`code: 4001`) when
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
    const announced = discoverProviders().find((detail) => detail.info.rdns === this.rdns);
    if (announced === undefined) {
      throw new BrowserWalletNotAnnouncedError(this.rdns);
    }
    const { info, provider } = announced;

    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const firstAccount = accounts[0];
    if (firstAccount === undefined) {
      throw new BrowserWalletError(`Wallet ${info.name} returned no accounts.`);
    }

    const appChainId = Number(this.config.chainId);
    let walletChainId = hexToNumber(await provider.request({ method: "eth_chainId" }));
    if (walletChainId !== appChainId) {
      // Best-effort: a wallet that cannot or will not switch is handled
      // by the re-check, so its rejection carries no extra information.
      await provider
        .request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: numberToHex(appChainId) }],
        })
        .catch(() => {
          // Best-effort: the re-check below decides whether it worked.
        });
      walletChainId = hexToNumber(await provider.request({ method: "eth_chainId" }));
      if (walletChainId !== appChainId) {
        throw new BrowserWalletChainMismatchError(info.name, walletChainId, appChainId);
      }
    }

    const account = getAddress(firstAccount);
    const client = createWalletClient({
      account,
      chain: toViemChain(this.config),
      transport: custom(provider),
    });

    const onSessionEvent = (): void => {
      this.onSessionChanged?.();
    };
    provider.on("accountsChanged", onSessionEvent);
    provider.on("chainChanged", onSessionEvent);

    this.connected = { info, provider, account, client, onSessionEvent };
  }

  /**
   * Forget the connection, so a later {@link connect} prompts again, and
   * stop listening to the provider's session events.
   *
   * EIP-1193 has no disconnect call, so this drops this object's reference
   * and nothing more: the extension still regards the site as connected, and
   * reconnecting may well not prompt the user again.
   *
   * @returns A resolved promise: the drop is synchronous, and the Promise
   *   shape is the {@link Wallet} contract.
   */
  disconnect(): Promise<void> {
    const connected = this.connected;
    this.connected = undefined;
    if (connected) {
      connected.provider.removeListener("accountsChanged", connected.onSessionEvent);
      connected.provider.removeListener("chainChanged", connected.onSessionEvent);
    }
    return Promise.resolve();
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
   * The rdns the wallet was connected through: stable per extension install,
   * so reconnecting the same extension scopes to the same storage and
   * queries.
   *
   * @returns The wallet's EIP-6963 rdns.
   */
  get id(): string {
    return this.requireConnected().info.rdns;
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
   * The connected account.
   *
   * @returns The address, checksummed.
   */
  get account(): Address {
    return this.requireConnected().account;
  }

  /**
   * A viem wallet client over the extension's provider: every signing action
   * raises the extension's own prompt.
   *
   * @returns The account-bound client.
   */
  get client(): EvmWalletClient {
    return this.requireConnected().client;
  }
}
