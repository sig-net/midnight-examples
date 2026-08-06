// The unified EVM wallet abstraction the rest of the app codes against.
//
// Both a connected browser-extension wallet ({@link BrowserWallet}, over an
// EIP-6963-announced EIP-1193 provider) and a seed-derived wallet held in-app
// ({@link SeedWallet}, over a viem local account) implement this `Wallet`
// interface, so nothing outside this folder branches on which kind it holds.
// The one place the kind matters is choosing how to obtain a wallet in the
// first place: connecting an extension versus installing from a seed, which is
// the wallet context's job.
import type { Account, Address, Chain, Transport, WalletClient } from "viem";

/**
 * The kind of underlying wallet a {@link Wallet} abstracts over. Lets callers
 * label a wallet's origin without re-introducing the concrete type the
 * interface exists to hide.
 */
export enum WalletKind {
    /** A connected browser-extension wallet (EIP-6963 announced). */
    Browser = "browser",
    /** Derived from a seed and run in-app (a viem local account). */
    Seed = "seed",
}

/**
 * Base of every error the wallet modules raise, so a caller can tell a wallet
 * failure from a bug in its own code with one `instanceof`.
 *
 * A browser provider's own failures are NOT of this kind and pass through
 * untouched: EIP-1193 rejections are plain errors carrying a numeric `code`
 * (`4001` when the user declines a prompt), recognisable only by that code,
 * never by `instanceof`.
 */
export class WalletError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * The viem wallet client a {@link Wallet} exposes: transport, chain and
 * account all bound, so every action can be called without restating them.
 * The generics are the wide viem base types on purpose: both a
 * `custom()`-backed client (browser wallet) and an `http()`-backed one (seed
 * wallet) are assignable.
 */
export type EvmWalletClient = WalletClient<Transport, Chain, Account>;

/**
 * The unified wallet handle: the identity the UI renders, the account it
 * reads balances for, and the viem client that signs and sends for it.
 */
export interface Wallet {
    /** Which kind of wallet this wraps. */
    readonly kind: WalletKind;
    /**
     * Stable identifier of the wallet: scopes browser storage and query keys.
     * A browser wallet's EIP-6963 rdns, a seed wallet's derived address:
     * stable across reconnects of the same wallet, different between wallets.
     */
    readonly id: string;
    /** User-facing label. Render as a text node: a browser wallet's is the extension's own string. */
    readonly name: string;
    /** The wallet's own icon as a URL or data URL, when it published one. */
    readonly iconUrl: string | undefined;
    /** The wallet's account address, checksummed. */
    readonly account: Address;
    /**
     * A viem wallet client bound to {@link Wallet.account} and the app's
     * chain. A browser wallet routes requests through the extension, so
     * signing raises its prompt; a seed wallet signs in-app and submits over
     * the app's RPC URL without prompting.
     */
    readonly client: EvmWalletClient;
    /**
     * Forget the wallet's connection and keys. The wallet is unusable
     * afterwards; obtain a fresh one to reconnect.
     */
    disconnect(): Promise<void>;
}
