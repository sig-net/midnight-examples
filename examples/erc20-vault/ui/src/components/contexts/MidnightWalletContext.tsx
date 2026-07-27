import type { MidnightNodeConfig } from "@midnight-examples/chain-config";
import type {
  Configuration,
  ConnectedAPI,
  InitialAPI,
} from "@midnight-ntwrk/dapp-connector-api";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import { useMidnightChainConfig } from "./MidnightChainConfigContext.tsx";

/**
 * An injected wallet's self-description (`rdns`, `name`, `icon`, `apiVersion`,
 * each documented on the connector's `InitialAPI`), plus the `window.midnight`
 * key it was found under: the key to hand to
 * {@link MidnightWalletContextValue.connectBrowserWallet}.
 *
 * Derived from `InitialAPI` rather than restated, so a field the connector adds
 * arrives here for free. `connect` is dropped deliberately: connecting goes
 * through the context, which is what makes it concurrency-safe and network-
 * checked.
 *
 * `name` and `icon` come from the extension, so render them defensively: the
 * name as a text node and the icon as an `img` source, never as markup.
 */
export type InjectedMidnightWallet = Omit<InitialAPI, "connect"> & {
  readonly walletKey: string;
};

/**
 * The Midnight wallets currently injected into the page.
 *
 * Wallets inject their connector under an opaque, per-install key (Lace uses a
 * random UUID), so there is no key to hardcode: enumerate, let the user pick,
 * and pass the chosen `walletKey` to
 * {@link MidnightWalletContextValue.connectBrowserWallet}. One extension may
 * inject more than one entry, e.g. when it supports several API versions.
 *
 * @returns Every injected wallet, or an empty array when no extension is
 *   installed and enabled.
 */
export function availableBrowserWallets(): InjectedMidnightWallet[] {
  if (typeof window === "undefined" || window.midnight === undefined) {
    return [];
  }
  return Object.entries(window.midnight).map(([walletKey, injected]) => {
    // Everything the wallet says about itself, minus the connect call the
    // context owns. Spread rather than listed field by field, so this keeps
    // compiling and keeps carrying everything if the connector grows a field.
    const { connect, ...selfDescription } = injected;
    return { walletKey, ...selfDescription };
  });
}

/**
 * Open the connection prompt of the wallet injected under `walletKey`, and
 * confirm the wallet came back on the network the app is configured for.
 *
 * The network id passed to `connect` is only a HINT: the wallet is free to
 * connect on whichever network it is currently set to, so the network the app
 * runs against is only known once `getConfiguration` has been read back. A
 * wallet on the wrong network is rejected here rather than returned, so a
 * mismatch surfaces as a failed connection instead of as reads against one
 * network and writes signed for another.
 *
 * Only the network id is compared. The wallet's indexer / node / prover URIs
 * are its user's own preference and may legitimately differ from the app's
 * while addressing the same network, so a difference there is not an error.
 *
 * @param walletKey - The `window.midnight` key of the wallet to connect.
 * @param config - The chain config the app runs against.
 * @returns The connected wallet's API, confirmed to be on `config.networkId`.
 * @throws If nothing is injected under `walletKey`, if the wallet connected on
 *   a different network, or with the connector's own `APIError`
 *   (`code: 'Rejected'`) when the user declines the prompt.
 */
async function connectInjectedWallet(
  walletKey: string,
  config: MidnightNodeConfig,
): Promise<ConnectedAPI> {
  const injected: InitialAPI | undefined =
    typeof window === "undefined" ? undefined : window.midnight?.[walletKey];
  if (injected === undefined) {
    throw new Error(
      `No Midnight wallet injected at window.midnight.${walletKey}: is the extension installed and enabled?`,
    );
  }

  const api: ConnectedAPI = await injected.connect(config.networkId);
  const walletConfiguration: Configuration = await api.getConfiguration();
  if (walletConfiguration.networkId !== config.networkId) {
    throw new Error(
      `Wallet ${injected.name} connected on network "${walletConfiguration.networkId}", but this app runs against "${config.networkId}": switch the wallet's network and connect again.`,
    );
  }
  return api;
}

/** The connected browser wallet, and the operations that change it. */
export interface MidnightWalletContextValue {
  /** The connected wallet's API, or null while no wallet is connected. */
  readonly browserWallet: ConnectedAPI | null;
  /** The `window.midnight` key the wallet was connected through, or null. */
  readonly browserWalletKey: string | null;
  /** True while a connection prompt is outstanding. */
  readonly connecting: boolean;
  /**
   * Connect the wallet injected under `walletKey` (an opaque key from
   * {@link availableBrowserWallets}) and store it.
   *
   * Concurrency-safe, so a double-clicked button or a StrictMode double render
   * cannot raise two prompts: calls for the wallet already connected resolve to
   * it without prompting, and calls made while a connect for the same key is in
   * flight share that one prompt.
   *
   * A wallet is stored only once confirmed to be on the app's network, so
   * {@link MidnightWalletContextValue.browserWallet} is never a wallet pointed
   * at a different chain.
   *
   * @param walletKey - The `window.midnight` key of the wallet to connect.
   * @returns The connected wallet's API, also published as
   *   {@link MidnightWalletContextValue.browserWallet}.
   * @throws If nothing is injected under `walletKey`, if the user declines the
   *   prompt, if the wallet connected on a different network, or if a connect
   *   to a DIFFERENT wallet is already in flight.
   */
  readonly connectBrowserWallet: (walletKey: string) => Promise<ConnectedAPI>;
  /**
   * Forget the connected wallet.
   *
   * The connector API has no disconnect call, so this drops the app's reference
   * and nothing more: the extension still regards the site as connected, and
   * reconnecting the same wallet may not prompt again.
   */
  readonly disconnectBrowserWallet: () => void;
}

const MidnightWalletContext = createContext<MidnightWalletContextValue | null>(null);

// The connected wallet and the key it came from, held together so the two can
// never disagree about which injected wallet is in hand.
interface ConnectedBrowserWallet {
  readonly walletKey: string;
  readonly api: ConnectedAPI;
}

/** Props of {@link MidnightWalletProvider}. */
interface MidnightWalletProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's connection to a Midnight browser wallet. Mounted once at the
 * root, inside the chain config provider whose network id it connects with (see
 * {@link useMidnightChainConfig}), and read through {@link useMidnightWallet}.
 *
 * The connection lives in memory only: reconnecting after a reload is the
 * user's call, since it means a wallet prompt.
 *
 * @param props - The subtree that can read the wallet.
 * @returns The provider wrapping that subtree.
 */
export function MidnightWalletProvider({ children }: MidnightWalletProviderProps): JSX.Element {
  const { config } = useMidnightChainConfig();

  const [connected, setConnected] = useState<ConnectedBrowserWallet | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);

  // The in-flight connect, so concurrent calls share one prompt instead of
  // racing two `injected.connect()` calls. A ref, not state, so a second call
  // in the same tick sees it: a state update would not land until the next
  // render, which is exactly when the race happens.
  const inFlightRef = useRef<{ walletKey: string; promise: Promise<ConnectedAPI> } | null>(null);

  const connectBrowserWallet = useCallback(
    (walletKey: string): Promise<ConnectedAPI> => {
      const inFlight = inFlightRef.current;
      if (inFlight !== null) {
        if (inFlight.walletKey !== walletKey) {
          return Promise.reject(
            new Error(
              `Already connecting to window.midnight.${inFlight.walletKey}: wait for that to settle before connecting to ${walletKey}.`,
            ),
          );
        }
        return inFlight.promise;
      }
      if (connected !== null && connected.walletKey === walletKey) {
        return Promise.resolve(connected.api);
      }

      const promise = connectInjectedWallet(walletKey, config)
        .then((api) => {
          setConnected({ walletKey, api });
          return api;
        })
        .finally(() => {
          inFlightRef.current = null;
          setConnecting(false);
        });

      inFlightRef.current = { walletKey, promise };
      setConnecting(true);
      return promise;
    },
    [config, connected],
  );

  const disconnectBrowserWallet = useCallback((): void => {
    setConnected(null);
  }, []);

  const value = useMemo<MidnightWalletContextValue>(
    () => ({
      browserWallet: connected?.api ?? null,
      browserWalletKey: connected?.walletKey ?? null,
      connecting,
      connectBrowserWallet,
      disconnectBrowserWallet,
    }),
    [connected, connecting, connectBrowserWallet, disconnectBrowserWallet],
  );

  return (
    <MidnightWalletContext.Provider value={value}>{children}</MidnightWalletContext.Provider>
  );
}

/**
 * Read the connected Midnight browser wallet.
 *
 * @returns The wallet and the operations that change it.
 * @throws If called outside a {@link MidnightWalletProvider}, since there is no
 *   sensible wallet to fall back to.
 */
export function useMidnightWallet(): MidnightWalletContextValue {
  const context = useContext(MidnightWalletContext);
  if (context === null) {
    throw new Error("useMidnightWallet must be used within a MidnightWalletProvider");
  }
  return context;
}
