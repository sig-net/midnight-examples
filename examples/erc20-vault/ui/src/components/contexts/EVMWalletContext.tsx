import type { EvmChainConfig } from "@midnight-examples/chain-config";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { describeError } from "../../lib/errorMessage.ts";
import { BrowserWallet, type BrowserWalletInfo } from "../../lib/evm/wallet/BrowserWallet.ts";
import { SeedWallet } from "../../lib/evm/wallet/SeedWallet.ts";
import { type Wallet, WalletError, WalletKind } from "../../lib/evm/wallet/Wallet.ts";
import { useEVMChainConfig } from "./EVMChainConfigContext.tsx";

/**
 * A connect was asked for while a connect to a DIFFERENT wallet was still
 * outstanding.
 *
 * Raised here rather than in the wallet classes: one wallet object only ever
 * speaks for the one wallet it was built with, so which wallet the app as a
 * whole is connecting is this context's question to answer.
 */
export class EVMWalletConnectBusyError extends WalletError {
  /**
   * @param inFlightTarget - The wallet the outstanding connect is building.
   * @param requestedTarget - The wallet the colliding call asked for.
   */
  constructor(
    readonly inFlightTarget: string,
    readonly requestedTarget: string,
  ) {
    super(
      `Already connecting ${inFlightTarget}: wait for that to settle before connecting ${requestedTarget}.`,
    );
  }
}

/** The app's EVM wallet, and the operations that change it. */
export interface EVMWalletContextValue {
  /**
   * The wallet in hand, or null while none is. Non-null ONLY once the wallet
   * is fully established (a browser wallet connected and confirmed to be on
   * the app's chain, a seed wallet's account derived), so a wallet
   * mid-connect, or one pointed at a different chain, never leaks out as
   * though it were ready.
   */
  readonly wallet: Wallet | null;
  /** True while a connect or install is outstanding. */
  readonly connecting: boolean;
  /**
   * Every EVM wallet currently announced to the page under EIP-6963, each
   * with the `rdns` to hand to
   * {@link EVMWalletContextValue.connectBrowserWallet}.
   *
   * Read on demand, not reactive: each call takes a fresh snapshot, so an
   * extension that announced late shows up on the next one.
   *
   * @returns The announced wallets, or an empty array when no extension is
   *   installed and enabled.
   */
  readonly availableBrowserWallets: () => BrowserWalletInfo[];
  /**
   * Connect the browser wallet announced under `rdns` (from
   * {@link EVMWalletContextValue.availableBrowserWallets}) and store it,
   * replacing (and disconnecting) whatever wallet was held before.
   *
   * Concurrency-safe, so a double-clicked button or a StrictMode double render
   * cannot raise two prompts: calls for the wallet already held resolve to it
   * without prompting, and calls made while a connect for the same rdns is in
   * flight share that one prompt.
   *
   * A wallet is stored only once confirmed to be on the app's chain, so
   * {@link EVMWalletContextValue.wallet} is never a wallet pointed at a
   * different chain. A stored wallet whose extension later reports a changed
   * account or chain is dropped, so a stale connection never lingers as
   * though it were live.
   *
   * @param rdns - The EIP-6963 rdns of the wallet to connect.
   * @returns The connected wallet, also published as
   *   {@link EVMWalletContextValue.wallet}.
   * @throws {EVMWalletConnectBusyError} if a connect to a DIFFERENT wallet is
   *   already in flight.
   * @throws {BrowserWalletNotAnnouncedError} if nothing is announced under
   *   `rdns`, {@link BrowserWalletChainMismatchError} if the wallet stayed on
   *   a different chain, or the provider's own EIP-1193 error (`code: 4001`)
   *   when the user declines the prompt.
   */
  readonly connectBrowserWallet: (rdns: string) => Promise<Wallet>;
  /**
   * Derive a seed wallet from `seed` and store it, replacing (and
   * disconnecting) whatever wallet was held before. Shares the same
   * concurrency guard as
   * {@link EVMWalletContextValue.connectBrowserWallet}.
   *
   * The wallet runs in-app: its keys live in this page's memory for as long
   * as it is held, and nothing prompts before signing. Meant for development
   * against a local stack, where the funded seeds are hex constants. The
   * seed is this chain's own, fully independent of the Midnight wallet's.
   *
   * @param seed - The wallet seed as hex (16-64 bytes, 0x optional).
   * @returns The installed wallet, also published as
   *   {@link EVMWalletContextValue.wallet}.
   * @throws {EVMWalletConnectBusyError} if a connect to a different wallet is
   *   already in flight, or {@link SeedWalletParseError} when the seed is not
   *   valid hex.
   */
  readonly installSeedWallet: (seed: string) => Promise<Wallet>;
  /**
   * Forget the held wallet (a browser extension still regards the site as
   * connected, and reconnecting it may not prompt again).
   */
  readonly disconnect: () => void;
}

const EVMWalletContext = createContext<EVMWalletContextValue | null>(null);

/** Props of {@link EVMWalletProvider}. */
interface EVMWalletProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's EVM wallet. Mounted once at the root, inside the chain
 * config provider whose chain it connects to (see {@link useEVMChainConfig}),
 * and read through {@link useEVMWallet}.
 *
 * The wallet itself is a {@link Wallet}: a browser extension connection or an
 * in-app seed wallet, behind one interface. This context only decides WHICH
 * wallet the app holds: it builds one per connect or install, keeps the one
 * that succeeds, and republishes it to React. The two entry points are the
 * only place the kind matters; everything downstream reads the interface.
 *
 * The wallet lives in memory only: reconnecting after a reload is the user's
 * call, since it means a wallet prompt (or re-entering a seed). A wallet is
 * built against the chain config in hand when it connects, so reconfiguring
 * the chain does not move a held wallet; the connect path refuses a
 * wrong-chain wallet, which is what keeps the two consistent.
 *
 * @param props - The subtree that can read the wallet.
 * @param props.children - The subtree the provider wraps.
 * @returns The provider wrapping that subtree.
 */
export function EVMWalletProvider({ children }: EVMWalletProviderProps): JSX.Element {
  const { config } = useEVMChainConfig();

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
          return Promise.reject(new EVMWalletConnectBusyError(inFlight.target, target));
        }
        return inFlight.promise;
      }

      const promise = build()
        .then((built) => {
          setWallet((previous) => {
            if (previous !== null && previous !== built) {
              // Fire-and-forget: the replaced wallet's teardown failing leaves
              // nothing the user could act on.
              void previous.disconnect().catch(() => undefined);
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
    (rdns: string): Promise<Wallet> => {
      if (wallet instanceof BrowserWallet && wallet.id === rdns) {
        return Promise.resolve(wallet);
      }
      // A fresh wallet per attempt, so a failed connect leaves nothing behind:
      // the one that reaches the context is the one that came back on the
      // app's chain.
      return establishWallet(`the ${rdns} wallet`, () => {
        const built: BrowserWallet = new BrowserWallet(config, rdns, () => {
          // The extension reported a changed account or chain, so the
          // published wallet is stale: drop it rather than let reads and
          // signatures run against a session it no longer describes. The
          // identity check keeps a callback from an already-replaced wallet
          // from clearing its successor.
          setWallet((previous) => {
            if (previous !== built) return previous;
            void built.disconnect().catch(() => undefined);
            return null;
          });
        });
        return built.connect().then(() => built);
      });
    },
    [config, wallet, establishWallet],
  );

  // The seed and config behind the held seed wallet. A seed wallet has no
  // extension owning its RPC endpoint, so the app's config IS its config, and
  // remembering both is what lets a config edit rebuild it below.
  const installedSeedRef = useRef<{ seed: string; config: EvmChainConfig } | null>(null);

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
  // extension owns its endpoints, and the connect path already enforces the
  // chain.
  useEffect(() => {
    const installed = installedSeedRef.current;
    if (wallet?.kind !== WalletKind.Seed || installed === null || installed.config === config) {
      return;
    }
    installSeedWallet(installed.seed).catch((error: unknown) => {
      toast.error("Could not move the EVM seed wallet to the new configuration", {
        description: describeError(error),
      });
    });
  }, [config, wallet, installSeedWallet]);

  const disconnect = useCallback((): void => {
    setWallet((previous) => {
      if (previous !== null) {
        // Fire-and-forget, as above: a teardown failure is not actionable.
        void previous.disconnect().catch(() => undefined);
      }
      return null;
    });
  }, []);

  const value = useMemo<EVMWalletContextValue>(
    () => ({
      wallet,
      connecting,
      availableBrowserWallets: () => BrowserWallet.available(),
      connectBrowserWallet,
      installSeedWallet,
      disconnect,
    }),
    [wallet, connecting, connectBrowserWallet, installSeedWallet, disconnect],
  );

  return <EVMWalletContext.Provider value={value}>{children}</EVMWalletContext.Provider>;
}

/**
 * Read the app's EVM wallet.
 *
 * @returns The wallet and the operations that change it.
 * @throws {Error} If called outside an {@link EVMWalletProvider}, since there
 *   is no sensible wallet to fall back to.
 */
export function useEVMWallet(): EVMWalletContextValue {
  const context = useContext(EVMWalletContext);
  if (context === null) {
    throw new Error("useEVMWallet must be used within an EVMWalletProvider");
  }
  return context;
}
