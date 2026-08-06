// Wallet extensions, faked at the boundary the app actually talks to.
//
// Neither chain is stubbed at the module level: each side really goes through
// its own BrowserWallet (`window.midnight` injection on Midnight, EIP-6963
// discovery on EVM), so what these tests exercise is the app's own code rather
// than a mock of it. That is also why the fakes are this small: the app
// touches very little of either connector.
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
  /**
   * What `signData` answers as the signature, given the data and how many
   * signing calls came before this one (0-based). Defaults to a DETERMINISTIC
   * function of the data alone, mirroring the deterministic signer the app's
   * identity derivation assumes. A test probing the non-deterministic case
   * passes one that varies with the call index.
   */
  readonly signDataSignature?: (data: string, callIndex: number) => string;
  /**
   * The shielded token balances it reports, keyed by token type. Defaults to
   * one holding, so a test that only cares that balances render has one.
   */
  readonly shieldedBalances?: Record<string, bigint>;
  /** The unshielded token balances it reports. Defaults to one holding. */
  readonly unshieldedBalances?: Record<string, bigint>;
  /** The dust it reports. Defaults to a balance under its cap. */
  readonly dustBalance?: { cap: bigint; balance: bigint };
}

/** The token type the fake's default shielded holding is denominated in. */
export const FAKE_SHIELDED_TOKEN_TYPE =
  "0100000000000000000000000000000000000000000000000000000000000001";

/** The token type the fake's default unshielded holding is denominated in. */
export const FAKE_UNSHIELDED_TOKEN_TYPE =
  "0200000000000000000000000000000000000000000000000000000000000002";

/**
 * Inject a Midnight wallet under `window.midnight`, the way an extension does.
 *
 * A successful connect echoes back the network id it was asked for, which is
 * what `BrowserWallet` compares against the app's own before it will publish
 * the wallet. Echoing rather than hardcoding keeps this fake correct whatever
 * network the app is configured for.
 *
 * @param options - The wallet's name, whether connecting fails, and how it
 *   signs.
 */
export function injectMidnightWallet({
  name,
  failWith,
  signDataSignature,
  shieldedBalances = { [FAKE_SHIELDED_TOKEN_TYPE]: 1_500n },
  unshieldedBalances = { [FAKE_UNSHIELDED_TOKEN_TYPE]: 2_500n },
  dustBalance = { cap: 9_000n, balance: 3_500n },
}: FakeMidnightWalletOptions): void {
  // Outside connect, so the count spans reconnects: what matters to the
  // non-determinism probe is how many signatures this WALLET has ever issued.
  let signDataCalls = 0;

  const injected: InitialAPI = {
    rdns: "network.sig.test-midnight-wallet",
    name,
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    apiVersion: "4.0.0",
    connect: (networkId: string): Promise<ConnectedAPI> =>
      failWith === undefined
        ? Promise.resolve({
            getConfiguration: () => Promise.resolve({ networkId }),
            // The Bech32m strings a real connector reports. The app treats
            // them as opaque identifiers (storage scoping), so stable
            // stand-ins suffice.
            getShieldedAddresses: () =>
              Promise.resolve({
                shieldedAddress: `mn_shield-addr_test1${name}`,
                shieldedCoinPublicKey: `mn_shield-cpk_test1${name}`,
                shieldedEncryptionPublicKey: `mn_shield-esk_test1${name}`,
              }),
            getShieldedBalances: () => Promise.resolve(shieldedBalances),
            getUnshieldedBalances: () => Promise.resolve(unshieldedBalances),
            getDustBalance: () => Promise.resolve(dustBalance),
            signData: (data: string) => {
              const callIndex = signDataCalls;
              signDataCalls += 1;
              return Promise.resolve({
                data,
                signature: (
                  signDataSignature ?? ((signed: string) => `signed:${name}:${signed}`)
                )(data, callIndex),
                verifyingKey: `verifying-key:${name}`,
              });
            },
          } as unknown as ConnectedAPI)
        : Promise.reject(failWith),
  };
  window.midnight = { [FAKE_MIDNIGHT_WALLET_KEY]: injected };
}

/** Remove the fake Midnight wallet, so the next test starts with none injected. */
export function clearMidnightWallets(): void {
  delete window.midnight;
}

/** An EIP-1193 provider, as much of one as the app's connect path calls. */
interface FakeEip1193Provider {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on: () => void;
  removeListener: () => void;
}

/** How the fake EVM wallet answers the app. */
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
 * The app's BrowserWallet discovers wallets by dispatching
 * `eip6963:requestProvider` and collecting the announcements that answer it
 * synchronously, so a fake has to do both: announce once now, for a listener
 * already in place, and again whenever a later snapshot asks.
 *
 * @param options - The wallet's name, chain and account.
 * @returns A function that stops it answering further requests.
 */
export function announceEvmWallet({
  name,
  chainId,
  address,
}: FakeEvmWalletOptions): StopAnnouncing {
  const provider: FakeEip1193Provider = {
    request: ({ method }) => {
      switch (method) {
        case "eth_requestAccounts":
          return Promise.resolve([address]);
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
