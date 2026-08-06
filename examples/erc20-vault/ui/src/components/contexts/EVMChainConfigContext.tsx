import {
  evmCaip2ChainId,
  evmChainById,
  LOCAL_EVM_CHAIN,
  type EvmChainConfig,
} from "@midnight-examples/chain-config";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

/**
 * The chain id named by `VITE_EVM_CHAIN_ID`, or the local dev chain's when
 * unset.
 *
 * This is the chain the app EXPECTS. Nothing here proves the RPC serves it:
 * that needs a live `eth_chainId` call, and it belongs with the first feature
 * that talks to the chain. Until then a mismatch is undetected.
 *
 * @param env - The build-time environment, normally `import.meta.env`.
 * @returns The expected chain id.
 * @throws If the variable is set to something that is not an integer, so a
 *   typo fails at startup rather than silently becoming a different chain.
 */
function readInitialChainId(env: ImportMetaEnv): bigint {
  const configured = env.VITE_EVM_CHAIN_ID?.trim();
  if (configured === undefined || configured === "") {
    return LOCAL_EVM_CHAIN.chainId;
  }
  try {
    return BigInt(configured);
  } catch (cause) {
    throw new Error(`Invalid VITE_EVM_CHAIN_ID "${configured}": expected an integer.`, { cause });
  }
}

/**
 * The starting EVM config: the local dev chain, with any `VITE_EVM_*` override
 * laid over the top.
 *
 * @param env - The build-time environment, normally `import.meta.env`.
 * @returns The config the app starts with.
 * @throws If an override is not a parsable absolute URL, or the chain id is
 *   not an integer.
 */
function readInitialConfig(env: ImportMetaEnv): EvmChainConfig {
  const rpcUrl = env.VITE_EVM_RPC_URL?.trim();
  const explorerUrl = env.VITE_EVM_EXPLORER_URL?.trim();

  return {
    chainId: readInitialChainId(env),
    rpcUrl: rpcUrl ? new URL(rpcUrl).toString() : LOCAL_EVM_CHAIN.rpcUrl,
    explorerUrl: explorerUrl ? new URL(explorerUrl).toString() : LOCAL_EVM_CHAIN.explorerUrl,
  };
}

const INITIAL_CONFIG: EvmChainConfig = readInitialConfig(import.meta.env);

/** The EVM chain config, and the operations that change it. */
export interface EVMChainConfigContextValue {
  /** The chain the app expects to be talking to. */
  readonly config: EvmChainConfig;
  /** That chain's CAIP-2 id, the form an example seals into its contract. */
  readonly caip2Id: string;
  /** Point at a different JSON-RPC endpoint. */
  readonly setRpcUrl: (rpcUrl: string) => void;
  /**
   * Expect a different chain id. A chain the named-chain table knows brings
   * its default RPC and explorer URLs with it, mirroring how selecting a
   * Midnight network resets its endpoints. An unknown id changes the id
   * alone, keeping whatever endpoints are configured.
   */
  readonly setChainId: (chainId: bigint) => void;
  /** Point at a different block explorer, or forget it with an empty string. */
  readonly setExplorerUrl: (explorerUrl: string) => void;
}

const EVMChainConfigContext = createContext<EVMChainConfigContextValue | null>(null);

/** Props of {@link EVMChainConfigProvider}. */
interface EVMChainConfigProviderProps {
  readonly children: ReactNode;
}

/**
 * Holds the EVM connection config in memory. Mounted once at the root so the
 * whole app shares one source of truth, read through
 * {@link useEVMChainConfig}. Consumers take an `EvmChainConfig` by argument
 * rather than reaching for this context themselves.
 *
 * @param props - The subtree that can read the config.
 * @returns The provider wrapping that subtree.
 */
export function EVMChainConfigProvider({ children }: EVMChainConfigProviderProps): JSX.Element {
  const [config, setConfig] = useState<EvmChainConfig>(INITIAL_CONFIG);

  // Each setter validates BEFORE queueing the state update: a throw inside a
  // setState updater fires during the next render and crashes the tree, while
  // a throw here surfaces at the call site, where the caller can report it.
  const setRpcUrl = useCallback((rpcUrl: string): void => {
    const normalised = new URL(rpcUrl).toString();
    setConfig((current) => ({ ...current, rpcUrl: normalised }));
  }, []);

  const setChainId = useCallback((chainId: bigint): void => {
    setConfig((current) => {
      const named = evmChainById(chainId);
      if (named === undefined) {
        return { ...current, chainId };
      }
      return {
        chainId: named.chainId,
        rpcUrl: named.rpcUrl,
        ...(named.explorerUrl === undefined ? {} : { explorerUrl: named.explorerUrl }),
      };
    });
  }, []);

  const setExplorerUrl = useCallback((explorerUrl: string): void => {
    const normalised = explorerUrl.trim() === "" ? undefined : new URL(explorerUrl).toString();
    setConfig((current) => {
      const { explorerUrl: dropped, ...rest } = current;
      return normalised === undefined ? rest : { ...rest, explorerUrl: normalised };
    });
  }, []);

  const value = useMemo<EVMChainConfigContextValue>(
    () => ({
      config,
      caip2Id: evmCaip2ChainId(config.chainId),
      setRpcUrl,
      setChainId,
      setExplorerUrl,
    }),
    [config, setRpcUrl, setChainId, setExplorerUrl],
  );

  return <EVMChainConfigContext.Provider value={value}>{children}</EVMChainConfigContext.Provider>;
}

/**
 * Read the EVM chain config.
 *
 * @returns The config and the operations that change it.
 * @throws If called outside an {@link EVMChainConfigProvider}, since there is
 *   no sensible default chain to fall back to.
 */
export function useEVMChainConfig(): EVMChainConfigContextValue {
  const context = useContext(EVMChainConfigContext);
  if (context === null) {
    throw new Error("useEVMChainConfig must be used within an EVMChainConfigProvider");
  }
  return context;
}
