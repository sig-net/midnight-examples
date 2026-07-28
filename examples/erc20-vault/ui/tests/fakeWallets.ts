// Wallet extensions, faked at the boundary the app actually talks to.
//
// Neither chain is stubbed at the module level: the Midnight side really goes
// through BrowserWallet and the EVM side really goes through wagmi's EIP-6963
// discovery, so what these tests exercise is the app's own code rather than a
// mock of it. That is also why the fakes are this small: the app touches very
// little of either connector.
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";

/** The `window.midnight` key the fake Midnight wallet is injected under. */
export const FAKE_MIDNIGHT_WALLET_KEY = "test-midnight-wallet";

/** How the fake Midnight wallet answers a connect. */
export interface FakeMidnightWalletOptions {
  /** The name the UI should offer and, once connected, show. */
  readonly name: string;
  /**
   * A rejection to fail the connect with. Omitted for a connect that succeeds
   * on whatever network the app asks for.
   */
  readonly failWith?: Error;
}

/**
 * Inject a Midnight wallet under `window.midnight`, the way an extension does.
 *
 * A successful connect echoes back the network id it was asked for, which is
 * what `BrowserWallet` compares against the app's own before it will publish
 * the wallet. Echoing rather than hardcoding keeps this fake correct whatever
 * network the app is configured for.
 *
 * @param options - The wallet's name, and whether connecting fails.
 */
export function injectMidnightWallet({ name, failWith }: FakeMidnightWalletOptions): void {
  const injected: InitialAPI = {
    rdns: "network.sig.test-midnight-wallet",
    name,
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    apiVersion: "4.0.0",
    connect: (networkId: string): Promise<ConnectedAPI> =>
      failWith === undefined
        ? Promise.resolve({
            getConfiguration: () => Promise.resolve({ networkId }),
          } as unknown as ConnectedAPI)
        : Promise.reject(failWith),
  };
  window.midnight = { [FAKE_MIDNIGHT_WALLET_KEY]: injected };
}

/** Remove the fake Midnight wallet, so the next test starts with none injected. */
export function clearMidnightWallets(): void {
  delete window.midnight;
}

/** An EIP-1193 provider, as much of one as wagmi's connect path calls. */
interface FakeEip1193Provider {
  request: (args: { method: string }) => Promise<unknown>;
  on: () => void;
  removeListener: () => void;
}

/** How the fake EVM wallet answers wagmi. */
export interface FakeEvmWalletOptions {
  /** The name the UI should offer and, once connected, show. */
  readonly name: string;
  /** The chain it reports being on. The app refuses anything but its own. */
  readonly chainId: number;
  /** The account it connects with. */
  readonly address: `0x${string}`;
}

/** Undo an EVM announcement, returned by {@link announceEvmWallet}. */
export type StopAnnouncing = () => void;

/**
 * Announce an EVM wallet under EIP-6963, the way an extension does.
 *
 * wagmi discovers wallets by dispatching `eip6963:requestProvider` and
 * listening for the announcements that answer it, so a fake has to do both:
 * announce once now, for a store that is already listening, and again whenever
 * a later store asks.
 *
 * @param options - The wallet's name, chain and account.
 * @returns A function that stops it answering further requests.
 */
export function announceEvmWallet({
  name,
  chainId,
  address,
}: FakeEvmWalletOptions): StopAnnouncing {
  // A wallet the user has not approved yet. The distinction matters: wagmi
  // tests for a prior approval with `eth_accounts`, and a wallet that answers
  // that with an account is one the app silently reconnects to. A fake that
  // always returned the account would therefore arrive already connected and
  // no test could ever exercise the connect click.
  let approved = false;

  const provider: FakeEip1193Provider = {
    request: ({ method }) => {
      switch (method) {
        case "eth_requestAccounts":
          approved = true;
          return Promise.resolve([address]);
        case "eth_accounts":
          return Promise.resolve(approved ? [address] : []);
        case "eth_chainId":
          return Promise.resolve(`0x${chainId.toString(16)}`);
        // The app asks the wallet to switch to its chain. This one is already
        // there, so it simply agrees.
        case "wallet_switchEthereumChain":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    },
    on: () => {},
    removeListener: () => {},
  };

  const detail = Object.freeze({
    info: Object.freeze({
      uuid: "11111111-2222-3333-4444-555555555555",
      name,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
      rdns: "network.sig.test-evm-wallet",
    }),
    provider,
  });

  const announce = (): void => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  };

  window.addEventListener("eip6963:requestProvider", announce);
  announce();

  return () => {
    window.removeEventListener("eip6963:requestProvider", announce);
  };
}
