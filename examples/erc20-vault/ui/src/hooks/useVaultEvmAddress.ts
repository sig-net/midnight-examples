import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { bytesToHex, getAddress, type Address } from "viem";

import {
  CallerIdentityStatus,
  useERC20Vault,
  useMidnightChainConfig,
  useMidnightWallet,
} from "../components/contexts";
import { describeError } from "../lib/errorMessage";

/** The vault's own EVM account, or why it cannot be read yet. */
export interface VaultEvmAddress {
  /** The address, or null until it has been read. */
  readonly address: Address | null;
  /**
   * Why {@link VaultEvmAddress.address} is null, when it is: a sentence to
   * render in its place. Null exactly when the address is non-null.
   */
  readonly unavailable: string | null;
}

/**
 * The vault's own EVM account, read from its ledger.
 *
 * This is the account every deposit transfers INTO and every withdrawal pays
 * out OF, and it belongs to the MPC network rather than to anyone here: the
 * contract derives it from its own Midnight address at initialize and pins it,
 * so the ledger is the only place it can honestly be read from.
 *
 * @returns The address, or the reason there is none to show.
 */
export function useVaultEvmAddress(): VaultEvmAddress {
  const { config } = useMidnightChainConfig();
  const { wallet } = useMidnightWallet();
  const { identityStatus, readContractState } = useERC20Vault();

  // The read goes through the wallet's providers against the deployed
  // contract, so those two are what it waits for. The caller's identity is not
  // involved: the vault's address is public ledger state.
  const noWallet = identityStatus === CallerIdentityStatus.NoWallet;
  const notDeployed = identityStatus === CallerIdentityStatus.NotDeployed;

  const query = useQuery<Address>({
    queryKey: [
      "vault-evm-address",
      config.networkId,
      wallet === null ? null : wallet.id,
    ],
    enabled: !noWallet && !notDeployed,
    // One indexer round trip: worth a second attempt, not worth the default's
    // four before the view admits anything is wrong.
    retry: 1,
    queryFn: async () => getAddress(bytesToHex((await readContractState()).vaultEvmAddress)),
  });

  return useMemo<VaultEvmAddress>(() => {
    if (noWallet) {
      return { address: null, unavailable: "Connect the Midnight wallet to read the vault." };
    }
    if (notDeployed) {
      return { address: null, unavailable: "The vault is not deployed on this network." };
    }
    if (query.error !== null) {
      return { address: null, unavailable: describeError(query.error) };
    }
    if (query.data === undefined) {
      return { address: null, unavailable: "Reading the vault's EVM address…" };
    }
    return { address: query.data, unavailable: null };
  }, [noWallet, notDeployed, query.error, query.data]);
}
