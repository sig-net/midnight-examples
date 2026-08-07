import {
  EVM_CHAINS,
  NETWORK_IDS,
  type NetworkId,
} from "@midnight-examples/chain-config";
import { useMemo } from "react";
import { toast } from "sonner";

import {
  useERC20Vault,
  useEVMChainConfig,
  useMidnightChainConfig,
  useMidnightWallet,
} from "../components/contexts";
import { describeError } from "../lib/errorMessage";

/** How a {@link ConfigField} is edited. */
export enum ConfigFieldKind {
  /** A fixed list of choices, rendered as a dropdown. */
  Select = "select",
  /** Free text, committed as a whole value. */
  Text = "text",
}

/** One choice of a {@link ConfigFieldKind.Select} field. */
export interface ConfigFieldOption {
  /** The value {@link ConfigField.apply} receives when chosen. */
  readonly value: string;
  /** What the dropdown shows for it. */
  readonly label: string;
}

/**
 * One configurable value, normalised for rendering: the settings panel shows
 * every field the same way and never knows which context it came from.
 */
export interface ConfigField {
  /** Stable identity of the field, unique across all sections. */
  readonly key: string;
  /** The label rendered beside the control. */
  readonly label: string;
  /** What the value means and what it accepts, for the field's info tooltip. */
  readonly info: string;
  /** How the field is edited. */
  readonly kind: ConfigFieldKind;
  /** The current value, as text ({@link ConfigFieldKind.Select}: an option's value). */
  readonly value: string;
  /** What an empty text field means, shown as its placeholder. */
  readonly placeholder?: string;
  /** The choices, present exactly when {@link ConfigField.kind} is Select. */
  readonly options?: readonly ConfigFieldOption[];
  /**
   * The connected wallet's own value, present exactly when the wallet
   * reports one that differs from the app's: the signal behind the panel's
   * mismatch warning.
   */
  readonly walletValue?: string;
  /**
   * Apply a new value. A rejected value (an invalid URL, a malformed key) is
   * reported on a toast and leaves the stored value unchanged.
   *
   * @param value - The new value, as the control holds it.
   * @returns True when the value was applied.
   */
  readonly apply: (value: string) => boolean;
}

/** One titled group of fields, mirroring the app's config surfaces. */
export interface ConfigSection {
  /** The heading the panel renders over the group. */
  readonly title: string;
  /** The section's fields, in display order. */
  readonly fields: readonly ConfigField[];
}

// Compare an app URL with the URI a wallet reports, tolerating formatting
// differences (a missing trailing slash) that URL parsing normalises away.
function differingWalletUri(walletUri: string | undefined, appUrl: string): string | undefined {
  if (walletUri === undefined || walletUri.trim() === "") {
    return undefined;
  }
  const normalise = (value: string): string => {
    try {
      return new URL(value).toString();
    } catch {
      return value.trim();
    }
  };
  return normalise(walletUri) === normalise(appUrl) ? undefined : walletUri;
}

// Wrap a throwing setter into ConfigField.apply: failures land on a toast
// carrying the setter's own message, and the stored value stays.
function applyOf(label: string, set: (value: string) => void): (value: string) => boolean {
  return (value: string): boolean => {
    try {
      set(value);
      return true;
    } catch (error) {
      toast.error(`Could not apply ${label}`, { description: describeError(error) });
      return false;
    }
  };
}

/**
 * Every configurable value of the app, normalised into titled sections for
 * the settings panel: the vault's own settings, then one section per chain.
 *
 * The chain-shaped differences (which context owns a value, how a wallet
 * reports its own configuration) are resolved here, so the panel just
 * renders fields. Where the connected Midnight browser wallet reports a
 * service endpoint that differs from the app's, the field carries the
 * wallet's value as {@link ConfigField.walletValue}: informational, since an
 * extension's endpoints are its user's own preference and the app cannot
 * change them. Seed wallets never differ: the wallet contexts rebuild them
 * whenever the config changes.
 *
 * @returns The sections, in display order.
 */
export function useAppConfig(): readonly ConfigSection[] {
  const midnight = useMidnightChainConfig();
  const evm = useEVMChainConfig();
  const vault = useERC20Vault();
  const { wallet: midnightWallet } = useMidnightWallet();

  // The connected wallet's own service endpoints, when it reports any (only
  // a browser wallet does).
  const walletConfiguration = midnightWallet?.configuration ?? null;

  return useMemo<readonly ConfigSection[]>(() => {
    const vaultSection: ConfigSection = {
      title: "ERC20 vault",
      fields: [
        {
          key: "mpc-pubkey",
          label: "MPC public key",
          info: "The MPC network's root secp256k1 public key: 33-byte compressed or 65-byte uncompressed, hex, 0x optional. Deposit addresses derive from it. Left empty, the app says the address cannot be derived. The local fakenet prints its key as MPC_ROOT_PUBLIC_KEY in the repo-root .env.",
          kind: ConfigFieldKind.Text,
          value: vault.mpcPubkey ?? "",
          placeholder: "Not set",
          apply: applyOf("MPC public key", vault.setMpcPubkey),
        },
        {
          key: "contract-address",
          label: "Contract address",
          info: "The vault's Midnight contract address on the selected network. Each network keeps its own value, defaulting to the known deployment there, and empty means the vault is not deployed on that network.",
          kind: ConfigFieldKind.Text,
          value: vault.contractAddress ?? "",
          placeholder: "Not deployed",
          apply: applyOf("Contract address", vault.setContractAddress),
        },
      ],
    };

    const midnightSection: ConfigSection = {
      title: "Midnight",
      fields: [
        {
          key: "midnight-network",
          label: "Network",
          info: `Which Midnight network to run against: one of ${NETWORK_IDS.join(", ")}. Selecting one resets every endpoint below to that network's published defaults, so pick the network first and adjust endpoints after.`,
          kind: ConfigFieldKind.Select,
          value: midnight.config.networkId,
          options: NETWORK_IDS.map((networkId) => ({ value: networkId, label: networkId })),
          apply: applyOf("Network", (value) => {
            midnight.setNetworkId(value as NetworkId);
          }),
        },
        {
          key: "midnight-indexer-url",
          label: "Indexer URL",
          info: "Indexer GraphQL over HTTP. Setting it also derives the WebSocket URL below, so the two cannot point at different hosts.",
          kind: ConfigFieldKind.Text,
          value: midnight.config.indexerUrl,
          walletValue: differingWalletUri(
            walletConfiguration?.indexerUri,
            midnight.config.indexerUrl,
          ),
          apply: applyOf("Indexer URL", midnight.setIndexerUrl),
        },
        {
          key: "midnight-indexer-ws-url",
          label: "Indexer WebSocket URL",
          info: "Indexer GraphQL over WebSocket. Normally derived from the HTTP URL: set it directly only when it is not simply the HTTP URL's twin.",
          kind: ConfigFieldKind.Text,
          value: midnight.config.indexerWsUrl,
          walletValue: differingWalletUri(
            walletConfiguration?.indexerWsUri,
            midnight.config.indexerWsUrl,
          ),
          apply: applyOf("Indexer WebSocket URL", midnight.setIndexerWsUrl),
        },
        {
          key: "midnight-node-url",
          label: "Node URL",
          info: "Midnight node RPC over HTTP. The wallet facade derives its WebSocket relay from it.",
          kind: ConfigFieldKind.Text,
          value: midnight.config.nodeUrl,
          walletValue: differingWalletUri(
            walletConfiguration?.substrateNodeUri,
            midnight.config.nodeUrl,
          ),
          apply: applyOf("Node URL", midnight.setNodeUrl),
        },
        {
          key: "midnight-proof-server-url",
          label: "Proof server URL",
          info: "Proof server for ZK proof generation. Keep it local: it sees private witness data.",
          kind: ConfigFieldKind.Text,
          value: midnight.config.proofServerUrl,
          walletValue: differingWalletUri(
            walletConfiguration?.proverServerUri,
            midnight.config.proofServerUrl,
          ),
          apply: applyOf("Proof server URL", midnight.setProofServerUrl),
        },
      ],
    };

    // The named chains, plus the configured chain when the table does not
    // know it (a VITE_EVM_CHAIN_ID override): the dropdown must always be
    // able to display the current value.
    const chainValue = evm.config.chainId.toString();
    const chainOptions: ConfigFieldOption[] = EVM_CHAINS.map((chain) => ({
      value: chain.chainId.toString(),
      label: `${chain.name} (${chain.chainId.toString()})`,
    }));
    if (!chainOptions.some((option) => option.value === chainValue)) {
      chainOptions.push({ value: chainValue, label: `Chain ${chainValue}` });
    }

    const evmSection: ConfigSection = {
      title: "EVM",
      fields: [
        {
          key: "evm-chain",
          label: "Chain",
          info: "The EVM chain the app expects. The id is sealed into the vault as its eip155 routing key, so it must match the chain the RPC actually serves. Selecting a named chain brings its default RPC and explorer URLs with it.",
          kind: ConfigFieldKind.Select,
          value: chainValue,
          options: chainOptions,
          apply: applyOf("Chain", (value) => {
            evm.setChainId(BigInt(value));
          }),
        },
        {
          key: "evm-rpc-url",
          label: "RPC URL",
          info: "JSON-RPC endpoint of the EVM chain. Balance reads and the seed wallet's submissions go through it, while a browser wallet uses its own endpoint.",
          kind: ConfigFieldKind.Text,
          value: evm.config.rpcUrl,
          apply: applyOf("RPC URL", evm.setRpcUrl),
        },
        {
          key: "evm-explorer-url",
          label: "Explorer URL",
          info: "Block explorer base URL, for linking transactions and addresses. Empty forgets it: not every chain has one.",
          kind: ConfigFieldKind.Text,
          value: evm.config.explorerUrl ?? "",
          placeholder: "None",
          apply: applyOf("Explorer URL", evm.setExplorerUrl),
        },
      ],
    };

    return [vaultSection, midnightSection, evmSection];
  }, [midnight, evm, vault, walletConfiguration]);
}
