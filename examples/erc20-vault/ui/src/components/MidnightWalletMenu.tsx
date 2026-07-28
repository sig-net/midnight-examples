import { useCallback, useState, type JSX } from "react";
import { toast } from "sonner";

import { describeError } from "../lib/errorMessage";
import type { BrowserWalletInfo } from "../lib/midnight/MidnightBrowserWallet.ts";
import { useMidnightWallet } from "./contexts";
import { WalletMenu, type WalletChoice } from "./WalletMenu";

/**
 * The header's Midnight wallet control, over {@link useMidnightWallet}.
 *
 * @returns The wallet icon and its menu.
 */
export const MidnightWalletMenu = (): JSX.Element => {
  const { browserWallet, connecting, availableBrowserWallets, connectBrowserWallet, disconnectBrowserWallet } =
    useMidnightWallet();

  // Injected wallets are read on demand rather than subscribed to: extensions
  // inject on page load and the connector publishes no announcement. Snapshot
  // them each time the menu opens, which is the moment the list is looked at.
  const [injected, setInjected] = useState<readonly BrowserWalletInfo[]>([]);

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (open) {
        setInjected(availableBrowserWallets());
      }
    },
    [availableBrowserWallets],
  );

  const handleConnect = useCallback(
    (walletKey: string): void => {
      connectBrowserWallet(walletKey).catch((error: unknown) => {
        toast.error("Could not connect the Midnight wallet", {
          description: describeError(error),
        });
      });
    },
    [connectBrowserWallet],
  );

  const choices: readonly WalletChoice[] = injected.map((wallet) => ({
    id: wallet.walletKey,
    name: wallet.name,
    iconUrl: wallet.icon,
  }));

  return (
    <WalletMenu
      chainName="Midnight"
      connected={
        browserWallet === null
          ? null
          : {
              name: browserWallet.info.name,
              iconUrl: browserWallet.info.icon,
              detail: undefined,
            }
      }
      connecting={connecting}
      choices={choices}
      onOpenChange={handleOpenChange}
      onConnect={handleConnect}
      onDisconnect={disconnectBrowserWallet}
    />
  );
};
