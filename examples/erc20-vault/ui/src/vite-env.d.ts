/// <reference types="vite/client" />

// Vite exposes only VITE_-prefixed variables to client code, and types the
// rest as `any` through an index signature. Naming each one here narrows it to
// `string | undefined` so a typo is a type error rather than a silent
// undefined at runtime. Every variable the app reads belongs in this list.
interface ImportMetaEnv {
  /** Which network to start on. One of the chain-config network ids. */
  readonly VITE_MIDNIGHT_NETWORK_ID?: string;
  /** Indexer GraphQL over HTTP, overriding that network's default. */
  readonly VITE_MIDNIGHT_INDEXER_URL?: string;
  /** Indexer GraphQL over WebSocket. Derived from the HTTP URL when unset. */
  readonly VITE_MIDNIGHT_INDEXER_WS_URL?: string;
  /** Midnight node RPC, overriding that network's default. */
  readonly VITE_MIDNIGHT_NODE_URL?: string;
  /** Proof server. Stays local by default: it sees private witness data. */
  readonly VITE_MIDNIGHT_PROOF_SERVER_URL?: string;
  /** JSON-RPC endpoint of the EVM chain, overriding the local dev chain's. */
  readonly VITE_EVM_RPC_URL?: string;
  /** The EVM chain id to expect. Must match what that RPC actually serves. */
  readonly VITE_EVM_CHAIN_ID?: string;
  /** Block explorer base URL, for linking transactions and addresses. */
  readonly VITE_EVM_EXPLORER_URL?: string;
  /**
   * The MPC network's root secp256k1 public key as hex (compressed or
   * uncompressed, 0x optional): what deposit addresses epsilon-derive from.
   * The local fakenet's key is generated per machine (`MPC_ROOT_PUBLIC_KEY`
   * in the repo-root .env), so there is no default to fall back to; unset, the
   * app renders everything except derived EVM addresses.
   */
  readonly VITE_MPC_ROOT_PUBLIC_KEY?: string;
  /**
   * The vault's Midnight contract address on the STARTING network,
   * overriding the per-network deployment table. A local deploy mints a
   * fresh address (`MIDNIGHT_VAULT_CONTRACT_ADDRESS` in the repo-root .env),
   * so a local run sets this to it.
   */
  readonly VITE_MIDNIGHT_VAULT_CONTRACT_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
