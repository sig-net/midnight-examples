import type { MidnightNodeConfig } from "@midnight-examples/chain-config";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { describeError } from "../../lib/errorMessage.ts";
import { BrowserWallet, type BrowserWalletInfo } from "../../lib/midnight/wallet/BrowserWallet.ts";
import { SeedWallet } from "../../lib/midnight/wallet/SeedWallet.ts";
import { WalletError, WalletKind, type Wallet } from "../../lib/midnight/wallet/Wallet.ts";
import { useMidnightChainConfig } from "./MidnightChainConfigContext.tsx";

/**
 * A connect was asked for while a connect to a DIFFERENT wallet was still
 * outstanding.
 *
 * Raised here rather than in the wallet classes: one wallet object only ever
 * speaks for the one wallet it was built with, so which wallet the app as a
 * whole is connecting is this context's question to answer.
 */
export class MidnightWalletConnectBusyError extends WalletError {
  constructor(
    readonly inFlightTarget: string,
    readonly requestedTarget: string,
  ) {
    super(
      `Already connecting ${inFlightTarget}: wait for that to settle before connecting ${requestedTarget}.`,
    );
  }
}

/** The app's Midnight wallet, and the operations that change it. */
export interface MidnightWalletContextValue {
  /**
   * The wallet in hand, or null while none is. Non-null ONLY once the wallet
   * is fully established (a browser wallet connected and confirmed to be on
   * the app's network, a seed wallet's facade started), so a wallet
   * mid-connect, or one pointed at a different chain, never leaks out as
   * though it were ready.
   */
  readonly wallet: Wallet | null;
  /** True while a connect or install is outstanding. */
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
   * Connect the browser wallet injected under `walletKey` (an opaque key from
   * {@link MidnightWalletContextValue.availableBrowserWallets}) and store it,
   * replacing (and disconnecting) whatever wallet was held before.
   *
   * Concurrency-safe, so a double-clicked button or a StrictMode double render
   * cannot raise two prompts: calls for the wallet already held resolve to it
   * without prompting, and calls made while a connect for the same key is in
   * flight share that one prompt.
   *
   * A wallet is stored only once confirmed to be on the app's network, so
   * {@link MidnightWalletContextValue.wallet} is never a wallet pointed at a
   * different chain.
   *
   * @param walletKey - The `window.midnight` key of the wallet to connect.
   * @returns The connected wallet, also published as
   *   {@link MidnightWalletContextValue.wallet}.
   * @throws {MidnightWalletConnectBusyError} if a connect to a DIFFERENT
   *   wallet is already in flight.
   * @throws {BrowserWalletNotInjectedError} if nothing is injected under
   *   `walletKey`, {@link BrowserWalletNetworkMismatchError} if the wallet
   *   connected on a different network, or the connector's own `APIError`
   *   (`code: 'Rejected'`) when the user declines the prompt.
   */
  readonly connectBrowserWallet: (walletKey: string) => Promise<Wallet>;
  /**
   * Derive a seed wallet from `seed`, start it, and store it, replacing (and
   * disconnecting) whatever wallet was held before. Shares the same
   * concurrency guard as
   * {@link MidnightWalletContextValue.connectBrowserWallet}.
   *
   * The wallet runs in-app: its keys live in this page's memory for as long
   * as it is held, and nothing prompts before signing. Meant for development
   * against a local stack, where the funded genesis seeds are hex constants.
   *
   * @param seed - The wallet seed as hex (16-64 bytes, 0x optional).
   * @returns The installed wallet, also published as
   *   {@link MidnightWalletContextValue.wallet}.
   * @throws {MidnightWalletConnectBusyError} if a connect to a different
   *   wallet is already in flight, {@link SeedWalletParseError} when the seed
   *   is not valid hex, or whatever the facade start raises (an unreachable
   *   indexer or node surfaces here).
   */
  readonly installSeedWallet: (seed: string) => Promise<Wallet>;
  /**
   * Forget the held wallet, releasing whatever it holds open (a seed
   * wallet's facade connections; a browser extension still regards the site
   * as connected, and reconnecting it may not prompt again).
   */
  readonly disconnect: () => void;
}

const MidnightWalletContext = createContext<MidnightWalletContextValue | null>(null);

/** Props of {@link MidnightWalletProvider}. */
interface MidnightWalletProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's Midnight wallet. Mounted once at the root, inside the chain
 * config provider whose network id it connects with (see
 * {@link useMidnightChainConfig}), and read through {@link useMidnightWallet}.
 *
 * The wallet itself is a {@link Wallet}: a browser extension connection or an
 * in-app seed wallet, behind one interface, and what consumers hand to the
 * Midnight providers. This context only decides WHICH wallet the app holds:
 * it builds one per connect or install, keeps the one that succeeds, and
 * republishes it to React. The two entry points are the only place the kind
 * matters; everything downstream reads the interface.
 *
 * The wallet lives in memory only: reconnecting after a reload is the user's
 * call, since it means a wallet prompt (or re-entering a seed).
 *
 * @param props - The subtree that can read the wallet.
 * @returns The provider wrapping that subtree.
 */
export function MidnightWalletProvider({ children }: MidnightWalletProviderProps): JSX.Element {
  const { config } = useMidnightChainConfig();

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);

  // The in-flight connect, so concurrent calls share one attempt instead of
  // building two wallets that each raise one. A ref, not state, so a second
  // call in the same tick sees it: a state update would not land until the
  // next render, which is exactly when the race happens. The target labels
  // which wallet is being built, so a colliding call for a DIFFERENT wallet
  // rejects rather than silently receiving the wrong one.
  const inFlightRef = useRef<{ target: string; promise: Promise<Wallet> } | null>(null);

  // Shared tail of both entry points: the busy guard, the in-flight bookkeeping,
  // and swapping the built wallet in (disconnecting the one it replaces).
  const establishWallet = useCallback(
    (target: string, build: () => Promise<Wallet>): Promise<Wallet> => {
      const inFlight = inFlightRef.current;
      if (inFlight !== null) {
        if (inFlight.target !== target) {
          return Promise.reject(new MidnightWalletConnectBusyError(inFlight.target, target));
        }
        return inFlight.promise;
      }

      const promise = build()
        .then((built) => {
          setWallet((previous) => {
            if (previous !== null && previous !== built) {
              // Fire-and-forget: the replaced wallet's teardown failing leaves
              // nothing the user could act on.
              void previous.disconnect().catch(() => {});
            }
            return built;
          });
          return built;
        })
        .finally(() => {
          inFlightRef.current = null;
          setConnecting(false);
        });

      inFlightRef.current = { target, promise };
      setConnecting(true);
      return promise;
    },
    [],
  );

  const connectBrowserWallet = useCallback(
    (walletKey: string): Promise<Wallet> => {
      if (wallet instanceof BrowserWallet && wallet.id === walletKey) {
        return Promise.resolve(wallet);
      }
      // A fresh wallet per attempt, so a failed connect leaves nothing behind:
      // the one that reaches the context is the one that came back on the
      // app's network.
      return establishWallet(`window.midnight.${walletKey}`, () =>
        BrowserWallet.Connect(config, walletKey),
      );
    },
    [config, wallet, establishWallet],
  );

  // The seed and config behind the held seed wallet. A seed wallet has no
  // extension owning its endpoints, so the app's config IS its config, and
  // remembering both is what lets a config edit rebuild it below.
  const installedSeedRef = useRef<{ seed: string; config: MidnightNodeConfig } | null>(null);

  const installSeedWallet = useCallback(
    (seed: string): Promise<Wallet> =>
      establishWallet("the seed wallet", () => SeedWallet.Initialise(config, seed)).then(
        (built) => {
          installedSeedRef.current = { seed, config };
          return built;
        },
      ),
    [config, establishWallet],
  );

  // A seed wallet follows the app's config. Guarded on the config the held
  // wallet was BUILT with, so the rebuild it triggers (a new wallet, same
  // config) does not trigger another. A browser wallet is left alone: its
  // extension owns its endpoints, and the app cannot reconfigure it.
  useEffect(() => {
    const installed = installedSeedRef.current;
    if (
      wallet === null ||
      wallet.kind !== WalletKind.Seed ||
      installed === null ||
      installed.config === config
    ) {
      return;
    }
    installSeedWallet(installed.seed).catch((error: unknown) => {
      toast.error("Could not move the Midnight seed wallet to the new configuration", {
        description: describeError(error),
      });
    });
  }, [config, wallet, installSeedWallet]);

  const disconnect = useCallback((): void => {
    setWallet((previous) => {
      if (previous !== null) {
        // Fire-and-forget, as above: a teardown failure is not actionable.
        void previous.disconnect().catch(() => {});
      }
      return null;
    });
  }, []);

  const value = useMemo<MidnightWalletContextValue>(
    () => ({
      wallet,
      connecting,
      availableBrowserWallets: BrowserWallet.available,
      connectBrowserWallet,
      installSeedWallet,
      disconnect,
    }),
    [wallet, connecting, connectBrowserWallet, installSeedWallet, disconnect],
  );

  return (
    <MidnightWalletContext.Provider value={value}>{children}</MidnightWalletContext.Provider>
  );
}

/**
 * Read the app's Midnight wallet.
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
