import type { EvmChainConfig } from "@midnight-examples/chain-config";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { defineChain, type Address } from "viem";
import {
  createConfig,
  http,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  WagmiProvider,
  type Config,
  type Connector,
} from "wagmi";

import { useEVMChainConfig } from "./EVMChainConfigContext.tsx";

/**
 * A wallet the browser announced, as much of it as a picker needs: `uid` is the
 * handle to connect by, `name` and `icon` are what the user recognises.
 *
 * Picked off wagmi's `Connector` rather than restated, so the two cannot drift.
 * The connector's own connect/disconnect calls are deliberately not part of
 * this shape: connecting goes through the context, which is what makes it
 * concurrency-safe and chain-checked.
 *
 * `name` and `icon` come from the extension, so render them defensively: the
 * name as a text node and the icon as an `img` source, never as markup.
 */
export type InjectedEvmWallet = Pick<Connector, "uid" | "id" | "name" | "icon">;

// One QueryClient for the app. Every wagmi hook is a TanStack Query query or
// mutation underneath, so a QueryClientProvider has to sit above them. Module
// scope, not component scope, so a re-render cannot swap the cache out.
const queryClient = new QueryClient();

/**
 * Build the wagmi config for one EVM chain.
 *
 * The chain's name and native currency are display metadata that
 * {@link EvmChainConfig} does not carry and nothing here depends on: what
 * matters is the chain id, which is the routing key an example seals into its
 * contract, and the RPC URL behind it.
 *
 * No connectors are configured. Wallets announce themselves under EIP-6963,
 * which wagmi discovers on its own, so the wallet list is whatever the browser
 * actually has rather than a hardcoded roster. MetaMask has announced itself
 * this way for years. A wallet reachable some other way (mobile deep-linking,
 * WalletConnect) needs its own connector here, and its own dependency.
 *
 * @param config - The EVM chain the app runs against.
 * @returns A wagmi config over that one chain.
 */
function createWagmiConfig(config: EvmChainConfig): Config {
  const chain = defineChain({
    id: Number(config.chainId),
    name: `EVM chain ${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorerUrl === undefined
      ? {}
      : { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } }),
  });
  return createConfig({
    chains: [chain],
    multiInjectedProviderDiscovery: true,
    transports: { [chain.id]: http(config.rpcUrl) },
  });
}

/** The connected EVM browser wallet, and the operations that change it. */
export interface EVMWalletContextValue {
  /**
   * The connected wallet, or null while none is. Non-null ONLY once the
   * connection is fully established, so a wallet mid-connect or mid-reconnect
   * never leaks out as though it were ready.
   */
  readonly browserWallet: Connector | null;
  /** The connected account's address, or null while no wallet is connected. */
  readonly account: Address | null;
  /**
   * The chain id the wallet is currently on, or null while none is connected.
   *
   * Confirmed to be the app's chain at connect time. The user can still switch
   * chain in the wallet afterwards, which lands here, so a consumer that signs
   * against the app's chain compares this first.
   */
  readonly chainId: number | null;
  /** Every wallet the browser announced, in wagmi's discovery order. */
  readonly availableWallets: readonly InjectedEvmWallet[];
  /** True while a connection prompt is outstanding. */
  readonly connecting: boolean;
  /**
   * Connect the wallet announced under `walletUid` (from
   * {@link EVMWalletContextValue.availableWallets}).
   *
   * Concurrency-safe, so a double-clicked button or a StrictMode double render
   * cannot raise two prompts: calls for the wallet already connected resolve to
   * it without prompting, and calls made while a connect for the same wallet is
   * in flight share that one prompt.
   *
   * A wallet that comes back on the wrong chain is disconnected again and the
   * call rejects, so {@link EVMWalletContextValue.browserWallet} is never a
   * wallet that connected to a different chain.
   *
   * @param walletUid - The `uid` of the wallet to connect.
   * @returns The connected wallet, also published as
   *   {@link EVMWalletContextValue.browserWallet}.
   * @throws If no wallet is announced under `walletUid`, if the user declines
   *   the prompt, if the wallet connected on a different chain, or if a connect
   *   to a DIFFERENT wallet is already in flight.
   */
  readonly connectBrowserWallet: (walletUid: string) => Promise<Connector>;
  /** Disconnect the wallet and forget it. */
  readonly disconnectBrowserWallet: () => void;
}

const EVMWalletContext = createContext<EVMWalletContextValue | null>(null);

/** Props of {@link EVMWalletBridge}. */
interface EVMWalletBridgeProps {
  readonly children: ReactNode;
}

/**
 * Publishes wagmi's connection state as {@link EVMWalletContextValue}.
 *
 * A separate component from the provider below on purpose: wagmi's hooks only
 * work underneath `WagmiProvider`, so the component reading them cannot be the
 * one mounting it.
 *
 * @param props - The subtree that can read the wallet.
 * @returns The context provider wrapping that subtree.
 */
function EVMWalletBridge({ children }: EVMWalletBridgeProps): JSX.Element {
  const { config } = useEVMChainConfig();
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connectWallet, isPending: connecting } = useConnect();
  const { mutate: disconnectWallet, mutateAsync: disconnectWalletAsync } = useDisconnect();

  // wagmi carries the chain id as a number; the app's config carries it as a
  // bigint, since that is what the contract and the MPC routing key use.
  const expectedChainId = Number(config.chainId);

  // Only the fully-connected shape has an address and a connector to hand out.
  const connected = connection.status === "connected" ? connection : null;

  // The in-flight connect, so concurrent calls share one prompt instead of
  // racing two of them. A ref, not state, so a second call in the same tick
  // sees it: a state update would not land until the next render, which is
  // exactly when the race happens.
  const inFlightRef = useRef<{ walletUid: string; promise: Promise<Connector> } | null>(null);

  const connectBrowserWallet = useCallback(
    (walletUid: string): Promise<Connector> => {
      const inFlight = inFlightRef.current;
      if (inFlight !== null) {
        if (inFlight.walletUid !== walletUid) {
          return Promise.reject(
            new Error(
              `Already connecting a wallet: wait for that to settle before connecting ${walletUid}.`,
            ),
          );
        }
        return inFlight.promise;
      }
      if (connected !== null && connected.connector.uid === walletUid) {
        return Promise.resolve(connected.connector);
      }

      const connector = connectors.find((candidate) => candidate.uid === walletUid);
      if (connector === undefined) {
        return Promise.reject(
          new Error(
            `No EVM wallet announced under uid ${walletUid}: is the extension installed and enabled?`,
          ),
        );
      }

      const promise = connectWallet({ connector, chainId: expectedChainId })
        .then(async (result): Promise<Connector> => {
          // Passing chainId asks the wallet to switch, it does not compel it:
          // a wallet that cannot switch connects on whatever chain it was on.
          // Undo such a connection rather than publish it, so a mismatch is a
          // failed connect instead of transactions signed for another chain.
          if (result.chainId !== expectedChainId) {
            await disconnectWalletAsync({ connector });
            throw new Error(
              `Wallet ${connector.name} connected to chain ${result.chainId}, but this app runs against chain ${expectedChainId}: switch the wallet's network and connect again.`,
            );
          }
          return connector;
        })
        .finally(() => {
          inFlightRef.current = null;
        });

      inFlightRef.current = { walletUid, promise };
      return promise;
    },
    [connectWallet, disconnectWalletAsync, connectors, connected, expectedChainId],
  );

  const disconnectBrowserWallet = useCallback((): void => {
    disconnectWallet();
  }, [disconnectWallet]);

  const value = useMemo<EVMWalletContextValue>(
    () => ({
      browserWallet: connected?.connector ?? null,
      account: connected?.address ?? null,
      chainId: connected?.chainId ?? null,
      availableWallets: connectors,
      connecting,
      connectBrowserWallet,
      disconnectBrowserWallet,
    }),
    [connected, connectors, connecting, connectBrowserWallet, disconnectBrowserWallet],
  );

  return <EVMWalletContext.Provider value={value}>{children}</EVMWalletContext.Provider>;
}

/** Props of {@link EVMWalletProvider}. */
interface EVMWalletProviderProps {
  readonly children: ReactNode;
}

/**
 * Owns the app's connection to an EVM browser wallet (MetaMask and anything
 * else the browser announces), over wagmi. Mounted once at the root, inside the
 * chain config provider whose chain it connects to (see
 * {@link useEVMChainConfig}), and read through {@link useEVMWallet}.
 *
 * The wagmi config is rebuilt whenever the app's chain config changes, which
 * drops any live connection with it: a wallet connected to the previous chain
 * is exactly what the connect path refuses to hand out.
 *
 * @param props - The subtree that can read the wallet.
 * @returns The provider wrapping that subtree.
 */
export function EVMWalletProvider({ children }: EVMWalletProviderProps): JSX.Element {
  const { config } = useEVMChainConfig();
  const wagmiConfig = useMemo<Config>(() => createWagmiConfig(config), [config]);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <EVMWalletBridge>{children}</EVMWalletBridge>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Read the connected EVM browser wallet.
 *
 * @returns The wallet and the operations that change it.
 * @throws If called outside an {@link EVMWalletProvider}, since there is no
 *   sensible wallet to fall back to.
 */
export function useEVMWallet(): EVMWalletContextValue {
  const context = useContext(EVMWalletContext);
  if (context === null) {
    throw new Error("useEVMWallet must be used within an EVMWalletProvider");
  }
  return context;
}
