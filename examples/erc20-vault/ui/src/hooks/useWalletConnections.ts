import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useEVMWallet, useMidnightWallet } from "../components/contexts";
import { describeError } from "../lib/errorMessage";
import { shortenAddress } from "../lib/shortenAddress";

/**
 * One wallet the user could connect: `id` is the handle to connect by, the rest
 * is what makes it recognisable.
 *
 * The two chains identify wallets by different things (a wagmi `uid`, a
 * `window.midnight` key), which is why this is an opaque `id`: everything above
 * these hooks passes it back untouched and never interprets it.
 */
export interface WalletChoice {
  readonly id: string;
  readonly name: string;
  /** The wallet's own icon, as a URL or data URL, when it published one. */
  readonly iconUrl: string | undefined;
}

/** The connected wallet, as much of it as the UI shows. */
export interface ConnectedWallet {
  readonly name: string;
  readonly iconUrl: string | undefined;
  /** A second line under the name: an address, a network, whatever identifies it. */
  readonly detail: string | undefined;
}

/**
 * One chain's wallet connection, in a shape that says nothing about which chain
 * it is.
 *
 * Both the header control and the connect step render this, which is the whole
 * point: the two connector APIs agree on nothing but the concept, and exactly
 * one place should have to know that.
 */
export interface WalletConnection {
  /** The chain, for labels and headings. */
  readonly chainName: string;
  /** The connected wallet, or null while none is. */
  readonly connected: ConnectedWallet | null;
  /** True while a connection prompt is outstanding. */
  readonly connecting: boolean;
  /** The wallets currently available to connect. */
  readonly choices: readonly WalletChoice[];
  /**
   * Re-read {@link WalletConnection.choices}.
   *
   * Worth calling when a picker opens: an extension that injected late, or one
   * enabled since the page loaded, only shows up on a re-read.
   */
  readonly refreshChoices: () => void;
  /** Connect the wallet under `walletId`, reporting a failure on a toast. */
  readonly connect: (walletId: string) => void;
  /**
   * Install an in-app wallet from a pasted seed, reporting a failure on a
   * toast. Present only for a chain that supports one (Midnight); the
   * controls offer a seed entry exactly when this is set.
   */
  readonly installFromSeed?: (seed: string) => void;
  /** Disconnect and forget the wallet. */
  readonly disconnect: () => void;
}

/**
 * The Midnight wallet, normalised.
 *
 * @returns That chain's connection.
 */
export function useMidnightWalletConnection(): WalletConnection {
  const {
    wallet,
    connecting,
    availableBrowserWallets,
    connectBrowserWallet,
    installSeedWallet,
    disconnect,
  } = useMidnightWallet();

  // Injected wallets are read on demand rather than subscribed to: extensions
  // inject on page load and the connector publishes no announcement to listen
  // for. Snapshot once on mount, and again whenever a consumer asks.
  const [injected, setInjected] = useState<readonly WalletChoice[]>([]);

  const refreshChoices = useCallback((): void => {
    setInjected(
      availableBrowserWallets().map((injectedWallet) => ({
        id: injectedWallet.walletKey,
        name: injectedWallet.name,
        iconUrl: injectedWallet.icon,
      })),
    );
  }, [availableBrowserWallets]);

  // Reading the injected wallets is a synchronous look at `window`, not a
  // fetch: there is nothing to cache, retry or race.
  useEffect(() => {
    refreshChoices();
  }, [refreshChoices]);

  const connect = useCallback(
    (walletKey: string): void => {
      connectBrowserWallet(walletKey).catch((error: unknown) => {
        toast.error("Could not connect the Midnight wallet", {
          description: describeError(error),
        });
      });
    },
    [connectBrowserWallet],
  );

  const installFromSeed = useCallback(
    (seed: string): void => {
      installSeedWallet(seed).catch((error: unknown) => {
        toast.error("Could not install the seed wallet", {
          description: describeError(error),
        });
      });
    },
    [installSeedWallet],
  );

  return useMemo<WalletConnection>(
    () => ({
      chainName: "Midnight",
      connected:
        wallet === null
          ? null
          : {
              name: wallet.name,
              iconUrl: wallet.iconUrl,
              detail: undefined,
            },
      connecting,
      choices: injected,
      refreshChoices,
      connect,
      installFromSeed,
      disconnect,
    }),
    [wallet, connecting, injected, refreshChoices, connect, installFromSeed, disconnect],
  );
}

/**
 * The EVM wallet, normalised.
 *
 * @returns That chain's connection.
 */
export function useEVMWalletConnection(): WalletConnection {
  const {
    browserWallet,
    account,
    availableWallets,
    connecting,
    connectBrowserWallet,
    disconnectBrowserWallet,
  } = useEVMWallet();

  const connect = useCallback(
    (walletUid: string): void => {
      connectBrowserWallet(walletUid).catch((error: unknown) => {
        toast.error("Could not connect the EVM wallet", {
          description: describeError(error),
        });
      });
    },
    [connectBrowserWallet],
  );

  // wagmi discovers wallets under EIP-6963 and republishes the list as they
  // announce, so unlike the Midnight side there is nothing to re-read.
  const refreshChoices = useCallback((): void => {}, []);

  const choices = useMemo<readonly WalletChoice[]>(
    () =>
      availableWallets.map((wallet) => ({
        id: wallet.uid,
        name: wallet.name,
        iconUrl: wallet.icon,
      })),
    [availableWallets],
  );

  return useMemo<WalletConnection>(
    () => ({
      chainName: "EVM",
      connected:
        browserWallet === null
          ? null
          : {
              name: browserWallet.name,
              iconUrl: browserWallet.icon,
              detail: account === null ? undefined : shortenAddress(account),
            },
      connecting,
      choices,
      refreshChoices,
      connect,
      disconnect: disconnectBrowserWallet,
    }),
    [browserWallet, account, connecting, choices, refreshChoices, connect, disconnectBrowserWallet],
  );
}

/** Every wallet the app needs, and how far along the user is. */
export interface WalletConnections {
  /** Each chain's connection, in the order the UI lists them. */
  readonly connections: readonly WalletConnection[];
  /** How many are connected. */
  readonly connectedCount: number;
  /** How many the app needs, which is how many chains it spans. */
  readonly requiredCount: number;
  /** True once every one of them is connected. */
  readonly allConnected: boolean;
}

/**
 * Both wallets at once, for anything that reports on the pair rather than on
 * one chain.
 *
 * The app bridges two chains, so a step is only done when BOTH are connected:
 * the count is what the connect step reports, and `allConnected` is what marks
 * it complete.
 *
 * @returns Both connections and the progress across them.
 */
export function useWalletConnections(): WalletConnections {
  const midnight = useMidnightWalletConnection();
  const evm = useEVMWalletConnection();

  return useMemo<WalletConnections>(() => {
    const connections = [midnight, evm];
    const connectedCount = connections.filter((one) => one.connected !== null).length;
    return {
      connections,
      connectedCount,
      requiredCount: connections.length,
      allConnected: connectedCount === connections.length,
    };
  }, [midnight, evm]);
}
