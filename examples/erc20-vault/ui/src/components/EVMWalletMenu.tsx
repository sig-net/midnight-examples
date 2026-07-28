import { useCallback, type JSX } from "react";
import { toast } from "sonner";

import { describeError } from "../lib/errorMessage";
import { useEVMWallet } from "./contexts";
import { WalletMenu, type WalletChoice } from "./WalletMenu";

/**
 * An EVM address, short enough for a menu but still recognisable.
 *
 * Both ends are kept: an address is compared by its ends in practice, and a
 * prefix alone matches far too many.
 *
 * @param address - The full checksummed address.
 * @returns The shortened form.
 */
function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The header's EVM wallet control, over {@link useEVMWallet}.
 *
 * @returns The wallet icon and its menu.
 */
export const EVMWalletMenu = (): JSX.Element => {
  const {
    browserWallet,
    account,
    availableWallets,
    connecting,
    connectBrowserWallet,
    disconnectBrowserWallet,
  } = useEVMWallet();

  const handleConnect = useCallback(
    (walletUid: string): void => {
      connectBrowserWallet(walletUid).catch((error: unknown) => {
        toast.error("Could not connect the EVM wallet", {
          description: describeError(error),
        });
      });
    },
    [connectBrowserWallet],
  );

  // No onOpenChange below: wagmi discovers wallets under EIP-6963 and
  // republishes the list as they announce, so unlike the Midnight side there is
  // nothing to re-read when the menu opens.
  const choices: readonly WalletChoice[] = availableWallets.map((wallet) => ({
    id: wallet.uid,
    name: wallet.name,
    iconUrl: wallet.icon,
  }));

  return (
    <WalletMenu
      chainName="EVM"
      connected={
        browserWallet === null
          ? null
          : {
              name: browserWallet.name,
              iconUrl: browserWallet.icon,
              detail: account === null ? undefined : shortenAddress(account),
            }
      }
      connecting={connecting}
      choices={choices}
      onConnect={handleConnect}
      onDisconnect={disconnectBrowserWallet}
    />
  );
};
