// The unified Midnight wallet abstraction the rest of the app codes against.
//
// Both a connected browser-extension wallet ({@link BrowserWallet}, over the
// dapp-connector API) and a seed-derived wallet held in-app ({@link SeedWallet},
// over the wallet-sdk facade) implement this `Wallet` interface, so nothing
// outside this folder branches on which kind it holds. The one place the kind
// matters is choosing how to obtain a wallet in the first place: connecting an
// extension versus installing from a seed, which is the wallet context's job.
import type { Configuration, Signature, SignDataOptions } from "@midnight-ntwrk/dapp-connector-api";
import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js/types";

/**
 * The kind of underlying wallet a {@link Wallet} abstracts over. Lets callers
 * label a wallet's origin without re-introducing the concrete type the
 * interface exists to hide.
 */
export enum WalletKind {
  /** A connected browser-extension wallet (dapp-connector API). */
  Browser = "browser",
  /** Derived from a seed and run in-app (the wallet-sdk facade). */
  Seed = "seed",
}

/**
 * Base of every error the wallet modules raise, so a caller can tell a wallet
 * failure from a bug in its own code with one `instanceof`.
 *
 * The dapp connector's own failures are NOT of this kind and pass through
 * untouched: they are plain `Error`s tagged `type: 'DAppConnectorAPIError'`
 * with a `code` (`'Rejected'` when the user declines the prompt). They are not
 * a class, so they can only be recognised by that tag, never by `instanceof`.
 */
export class WalletError extends Error {
  /**
   * @param message - The human-readable failure, fit to surface in a toast.
   */
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A wallet's dust: what it can spend now, and the ceiling generation is
 * working towards. Dust is generated from the wallet's Night rather than held
 * as a token, so the balance moves on its own between two reads.
 */
export interface DustBalance {
  /** The spendable balance, in atomic units. */
  readonly balance: bigint;
  /**
   * The generation ceiling, in atomic units, or null when the wallet does not
   * report one (the wallet-sdk facade exposes no cap; the browser connector
   * does).
   */
  readonly cap: bigint | null;
}

/**
 * The unified wallet handle: the two midnight-js provider roles a wallet
 * fills for the contract SDK ({@link WalletProvider} balances,
 * {@link MidnightProvider} submits), plus the identity, signing and balance
 * reads this app needs from whichever wallet it holds.
 */
export interface Wallet extends MidnightProvider, WalletProvider {
  /** Which kind of wallet this wraps. */
  readonly kind: WalletKind;
  /**
   * Stable identifier of the wallet: scopes browser storage and query keys.
   * Stable across reconnects of the same wallet, different between wallets.
   */
  readonly id: string;
  /** User-facing label. Render as a text node: a browser wallet's is the extension's own string. */
  readonly name: string;
  /** The wallet's own icon as a URL or data URL, when it published one. */
  readonly iconUrl: string | undefined;
  /**
   * The services the wallet itself uses (indexer, node, prover URIs), when it
   * has preferences of its own: a browser wallet reports its extension's
   * configuration, whose endpoints may legitimately differ from the app's
   * while addressing the same network. Null for a wallet with none (a seed
   * wallet runs on the config it was installed with, which the wallet
   * context keeps in step with the app's).
   */
  readonly configuration: Configuration | null;

  /**
   * Sign `data` with the key named in `options`.
   *
   * Neither implementation promises determinism: whether the same data and
   * key produce the same signature twice is the underlying signer's choice,
   * so a caller deriving anything from the signature must verify
   * reproducibility rather than assume it.
   *
   * @param data - The data to sign, encoded as `options.encoding` says.
   * @param options - The encoding of `data` and which key signs.
   * @returns The signature, with the signed data and verifying key.
   * @throws {Error} The connector's own `APIError` (`code: 'Rejected'`)
   *   when a browser wallet's user declines the signing prompt.
   */
  signData(data: string, options: SignDataOptions): Promise<Signature>;

  /**
   * The wallet's shielded token balances, keyed by token type, in atomic
   * units. A token type is opaque: the wallet carries no name, symbol or
   * decimals for it.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   */
  getShieldedBalances(): Promise<Record<string, bigint>>;

  /**
   * The wallet's unshielded token balances (Night among them), keyed by
   * token type, in atomic units. Same opacity as
   * {@link Wallet.getShieldedBalances}.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   */
  getUnshieldedBalances(): Promise<Record<string, bigint>>;

  /**
   * The wallet's dust (fee) balance.
   *
   * @returns The spendable balance, with the cap when the wallet reports one.
   */
  getDustBalance(): Promise<DustBalance>;

  /**
   * Release whatever the wallet holds open: a seed wallet stops its facade's
   * connections, a browser wallet forgets the extension connection. The
   * wallet is unusable afterwards; obtain a fresh one to reconnect.
   */
  disconnect(): Promise<void>;
}
