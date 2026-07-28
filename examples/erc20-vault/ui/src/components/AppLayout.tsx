import type { JSX } from "react";
import { Link, Outlet } from "react-router";

import { useEVMWalletConnection, useMidnightWalletConnection } from "../hooks/useWalletConnections";
import { RoutePath } from "../routes";
import { ThemeToggle } from "./ThemeToggle";
import { WalletMenu } from "./WalletMenu";

/**
 * The application shell: a persistent header and the footer that frame every
 * route. React Router renders the matched route into the `Outlet`, so the
 * shell mounts once and survives navigation.
 *
 * The header's right-hand side is the app's whole control surface: one wallet
 * icon per chain, and the theme. They live here rather than on a page because
 * a connection outlives navigation, and a control that disappeared on the way
 * to another route would suggest the connection had too.
 *
 * @returns The chrome wrapping the active route's view.
 */
export const AppLayout = (): JSX.Element => {
  const midnight = useMidnightWalletConnection();
  const evm = useEVMWalletConnection();

  return (
  <div className="flex min-h-screen flex-col bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-4">
        <Link to={RoutePath.Home} className="flex items-center gap-2.5">
          <img
            src="/sig-network.png"
            alt="Signature Network"
            className="size-7 rounded-full"
            width={28}
            height={28}
          />
          <span className="text-lg font-semibold tracking-tight">ERC20 vault</span>
        </Link>
        <span className="hidden text-sm text-muted-foreground sm:inline">Midnight example</span>

        <div className="ml-auto flex items-center gap-0.5">
          <WalletMenu connection={midnight} />
          <WalletMenu connection={evm} />
          <ThemeToggle />
        </div>
      </div>
    </header>

    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <Outlet />
    </main>

    <footer className="border-t border-border px-6 py-4 text-center text-sm text-muted-foreground">
      Bridging ERC20 assets to Midnight shielded UTXOs via the Signature Network.
    </footer>
  </div>
  );
};
