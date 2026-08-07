import {
  DEFAULT_ENDPOINTS,
  indexerWsUrlFromIndexerUrl,
  isNetworkId,
  NETWORK_IDS,
  type Endpoints,
  type MidnightNodeConfig,
  type NetworkId,
} from "@midnight-examples/chain-config";
import { setNetworkId as setSdkNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

/** The network the app falls back to: the local standalone Docker stack. */
const FALLBACK_NETWORK_ID: NetworkId = "undeployed";

// Selecting a network is the one place the midnight-js global network id is
// set. That global is read internally by the SDK, so it has to move in step
// with our own state or the two silently disagree.
function selectNetwork(networkId: NetworkId): Endpoints {
  setSdkNetworkId(networkId);
  return DEFAULT_ENDPOINTS[networkId];
}

/**
 * The network named by `VITE_MIDNIGHT_NETWORK_ID`, or the local standalone
 * stack when unset.
 *
 * @param env - The build-time environment, normally `import.meta.env`.
 * @returns The network the app starts on.
 * @throws If the variable is set to a network id chain-config does not know,
 *   so a typo fails at startup rather than rendering against nothing.
 */
function readInitialNetworkId(env: ImportMetaEnv): NetworkId {
  const configured = env.VITE_MIDNIGHT_NETWORK_ID?.trim();
  if (configured === undefined || configured === "") {
    return FALLBACK_NETWORK_ID;
  }
  if (!isNetworkId(configured)) {
    throw new Error(
      `Invalid VITE_MIDNIGHT_NETWORK_ID "${configured}": expected one of ${NETWORK_IDS.join(", ")}.`,
    );
  }
  return configured;
}

/**
 * The starting endpoints: the selected network's defaults, with any
 * `VITE_MIDNIGHT_*` override laid over the top. Overriding the indexer's HTTP
 * URL without its WebSocket twin derives the twin, so the two can never point
 * at different hosts.
 *
 * Overrides apply to the STARTING network only. Switching network at runtime
 * resets to that network's published defaults, which is why a network with no
 * published endpoints (stagenet) has to be selected through the environment.
 *
 * @param env - The build-time environment, normally `import.meta.env`.
 * @param defaults - The selected network's default endpoints.
 * @returns The endpoints the app starts with.
 * @throws If an override is not a parsable absolute URL.
 */
function readInitialEndpoints(env: ImportMetaEnv, defaults: Endpoints): Endpoints {
  const indexerUrl = env.VITE_MIDNIGHT_INDEXER_URL?.trim();
  const indexerWsUrl = env.VITE_MIDNIGHT_INDEXER_WS_URL?.trim();
  const nodeUrl = env.VITE_MIDNIGHT_NODE_URL?.trim();
  const proofServerUrl = env.VITE_MIDNIGHT_PROOF_SERVER_URL?.trim();

  return {
    indexerUrl: indexerUrl ? new URL(indexerUrl).toString() : defaults.indexerUrl,
    indexerWsUrl: indexerWsUrl
      ? new URL(indexerWsUrl).toString()
      : indexerUrl
        ? indexerWsUrlFromIndexerUrl(indexerUrl)
        : defaults.indexerWsUrl,
    nodeUrl: nodeUrl ? new URL(nodeUrl).toString() : defaults.nodeUrl,
    proofServerUrl: proofServerUrl ? new URL(proofServerUrl).toString() : defaults.proofServerUrl,
  };
}

// Resolved once at module load rather than per render: the network id is
// process-wide state inside the SDK, so it has to be set before the first
// render, and a bad VITE_MIDNIGHT_NETWORK_ID should fail at startup.
const INITIAL_NETWORK_ID: NetworkId = readInitialNetworkId(import.meta.env);
const INITIAL_ENDPOINTS: Endpoints = readInitialEndpoints(
  import.meta.env,
  selectNetwork(INITIAL_NETWORK_ID),
);

/** The chain connection config, and the operations that change it. */
export interface MidnightChainConfigContextValue {
  /** The full connection config for the currently selected network. */
  readonly config: MidnightNodeConfig;
  /** Switch network, resetting every endpoint to that network's defaults. */
  readonly setNetworkId: (networkId: NetworkId) => void;
  /** Point at a different indexer. The WebSocket twin is derived from it. */
  readonly setIndexerUrl: (indexerUrl: string) => void;
  /**
   * Point the indexer's WebSocket at its own URL, for the rare stack where it
   * is not simply the HTTP URL's twin. A later
   * {@link MidnightChainConfigContextValue.setIndexerUrl} re-derives the twin
   * and overwrites this.
   */
  readonly setIndexerWsUrl: (indexerWsUrl: string) => void;
  /** Point at a different Midnight node RPC. */
  readonly setNodeUrl: (nodeUrl: string) => void;
  /** Point at a different proof server. */
  readonly setProofServerUrl: (proofServerUrl: string) => void;
}

const MidnightChainConfigContext = createContext<MidnightChainConfigContextValue | null>(null);

/** Props of {@link MidnightChainConfigProvider}. */
interface MidnightChainConfigProviderProps {
  readonly children: ReactNode;
}

/**
 * Holds the chain connection config in memory and owns the selected network.
 * Mounted once at the root so the whole app shares one source of truth, read
 * through {@link useMidnightChainConfig}. Consumers take a `MidnightNodeConfig`
 * by argument rather than reaching for this context themselves.
 *
 * @param props - The subtree that can read the config.
 * @returns The provider wrapping that subtree.
 */
export function MidnightChainConfigProvider({
  children,
}: MidnightChainConfigProviderProps): JSX.Element {
  const [networkId, setNetworkIdState] = useState<NetworkId>(INITIAL_NETWORK_ID);
  const [endpoints, setEndpoints] = useState<Endpoints>(INITIAL_ENDPOINTS);

  const setNetworkId = useCallback((next: NetworkId): void => {
    setEndpoints(selectNetwork(next));
    setNetworkIdState(next);
  }, []);

  // Each setter validates BEFORE queueing the state update: a throw inside a
  // setState updater fires during the next render and crashes the tree, while
  // a throw here surfaces at the call site, where the caller can report it.
  const setIndexerUrl = useCallback((indexerUrl: string): void => {
    const normalised = new URL(indexerUrl).toString();
    const derivedWsUrl = indexerWsUrlFromIndexerUrl(indexerUrl);
    setEndpoints((current) => ({
      ...current,
      indexerUrl: normalised,
      indexerWsUrl: derivedWsUrl,
    }));
  }, []);

  const setIndexerWsUrl = useCallback((indexerWsUrl: string): void => {
    const normalised = new URL(indexerWsUrl).toString();
    setEndpoints((current) => ({ ...current, indexerWsUrl: normalised }));
  }, []);

  const setNodeUrl = useCallback((nodeUrl: string): void => {
    const normalised = new URL(nodeUrl).toString();
    setEndpoints((current) => ({ ...current, nodeUrl: normalised }));
  }, []);

  const setProofServerUrl = useCallback((proofServerUrl: string): void => {
    const normalised = new URL(proofServerUrl).toString();
    setEndpoints((current) => ({ ...current, proofServerUrl: normalised }));
  }, []);

  const value = useMemo<MidnightChainConfigContextValue>(
    () => ({
      config: { ...endpoints, networkId },
      setNetworkId,
      setIndexerUrl,
      setIndexerWsUrl,
      setNodeUrl,
      setProofServerUrl,
    }),
    [
      endpoints,
      networkId,
      setNetworkId,
      setIndexerUrl,
      setIndexerWsUrl,
      setNodeUrl,
      setProofServerUrl,
    ],
  );

  return (
    <MidnightChainConfigContext.Provider value={value}>
      {children}
    </MidnightChainConfigContext.Provider>
  );
}

/**
 * Read the chain connection config.
 *
 * @returns The config and the operations that change it.
 * @throws If called outside a {@link MidnightChainConfigProvider}, since there
 *   is no sensible default config to fall back to.
 */
export function useMidnightChainConfig(): MidnightChainConfigContextValue {
  const context = useContext(MidnightChainConfigContext);
  if (context === null) {
    throw new Error("useMidnightChainConfig must be used within a MidnightChainConfigProvider");
  }
  return context;
}
