import {
  BrowserWallet,
  BrowserWalletError,
  type BrowserWalletInfo,
} from "../../lib/midnight/MidnightBrowserWallet.ts";
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
 * A connect was asked for while a connect to a DIFFERENT injected wallet was
 * still outstanding.
 *
 * Raised here rather than in {@link BrowserWallet}: one wallet object only ever
 * speaks to the one injected wallet it was built with, so which wallet the app
 * as a whole is connecting is this context's question to answer.
 */
export class MidnightWalletConnectBusyError extends BrowserWalletError {
  constructor(
    readonly inFlightWalletKey: string,
    readonly requestedWalletKey: string,
  ) {
    super(
      `Already connecting to window.midnight.${inFlightWalletKey}: wait for that to settle before connecting to ${requestedWalletKey}.`,
    );
  }
}

/** The connected browser wallet, and the operations that change it. */
export interface MidnightWalletContextValue {
  /**
   * The connected wallet, or null while none is. Non-null ONLY once the
   * connection is fully established and confirmed to be on the app's network,
   * so a wallet mid-connect, or one pointed at a different chain, never leaks
   * out as though it were ready.
   */
  readonly browserWallet: BrowserWallet | null;
  /** The `window.midnight` key the wallet was connected through, or null. */
  readonly browserWalletKey: string | null;
  /** True while a connection prompt is outstanding. */
  readonly connecting: boolean;
  /**
   * Every Midnight wallet currently injected into the page, each with the
   * `walletKey` to hand to
   * {@link MidnightWalletContextValue.connectBrowserWallet}.
   *
   * Read on demand, not reactive: wallets inject on page load, and the
   * connector has no announcement to subscribe to.
   *
   * @returns The injected wallets, or an empty array when no extension is
   *   installed and enabled.
   */
  readonly availableBrowserWallets: () => BrowserWalletInfo[];
  /**
   * Connect the wallet injected under `walletKey` (an opaque key from
   * {@link MidnightWalletContextValue.availableBrowserWallets}) and store it.
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
   * @returns The connected wallet, also published as
   *   {@link MidnightWalletContextValue.browserWallet}.
   * @throws {MidnightWalletConnectBusyError} if a connect to a DIFFERENT wallet
   *   is already in flight.
   * @throws {BrowserWalletNotInjectedError} if nothing is injected under
   *   `walletKey`, {@link BrowserWalletNetworkMismatchError} if the wallet
   *   connected on a different network, or the connector's own `APIError`
   *   (`code: 'Rejected'`) when the user declines the prompt.
   */
  readonly connectBrowserWallet: (walletKey: string) => Promise<BrowserWallet>;
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

/** Props of {@link MidnightWalletProvider}. */
interface MidnightWalletProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's connection to a Midnight browser wallet. Mounted once at the
 * root, inside the chain config provider whose network id it connects with (see
 * {@link useMidnightChainConfig}), and read through {@link useMidnightWallet}.
 *
 * The connection itself lives in a {@link BrowserWallet}, which is what talks to
 * the extension and what consumers hand to the Midnight providers. This context
 * only decides WHICH wallet the app holds: it builds one per connect, keeps the
 * one that succeeds, and republishes it to React.
 *
 * The connection lives in memory only: reconnecting after a reload is the
 * user's call, since it means a wallet prompt.
 *
 * @param props - The subtree that can read the wallet.
 * @returns The provider wrapping that subtree.
 */
export function MidnightWalletProvider({ children }: MidnightWalletProviderProps): JSX.Element {
  const { config } = useMidnightChainConfig();

  const [connected, setConnected] = useState<BrowserWallet | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);

  // The in-flight connect, so concurrent calls share one prompt instead of
  // building two wallets that each raise one. A ref, not state, so a second call
  // in the same tick sees it: a state update would not land until the next
  // render, which is exactly when the race happens.
  const inFlightRef = useRef<{ walletKey: string; promise: Promise<BrowserWallet> } | null>(null);

  const connectBrowserWallet = useCallback(
    (walletKey: string): Promise<BrowserWallet> => {
      const inFlight = inFlightRef.current;
      if (inFlight !== null) {
        if (inFlight.walletKey !== walletKey) {
          return Promise.reject(new MidnightWalletConnectBusyError(inFlight.walletKey, walletKey));
        }
        return inFlight.promise;
      }
      if (connected !== null && connected.info.walletKey === walletKey) {
        return Promise.resolve(connected);
      }

      // A fresh wallet per attempt, so a failed connect leaves nothing behind:
      // the one that reaches `setConnected` is the one that came back on the
      // app's network.
      const wallet = new BrowserWallet(config, walletKey);
      const promise = wallet
        .connect()
        .then(() => {
          setConnected(wallet);
          return wallet;
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
    setConnected((wallet) => {
      wallet?.disconnect();
      return null;
    });
  }, []);

  const value = useMemo<MidnightWalletContextValue>(
    () => ({
      browserWallet: connected,
      browserWalletKey: connected?.info.walletKey ?? null,
      connecting,
      availableBrowserWallets: BrowserWallet.available,
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
