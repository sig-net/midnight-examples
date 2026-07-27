import type { JSX } from "react";
import { Link, Outlet } from "react-router";

import { RoutePath } from "../routes";

/**
 * The application shell: a persistent header and the footer that frame every
 * route. React Router renders the matched route into the `Outlet`, so the
 * shell mounts once and survives navigation.
 *
 * @returns The chrome wrapping the active route's view.
 */
export const AppLayout = (): JSX.Element => (
  <div className="flex min-h-screen flex-col bg-surface text-ink">
    <header className="border-b border-border-subtle bg-surface-raised">
      <div className="mx-auto flex w-full max-w-3xl items-baseline gap-3 px-6 py-4">
        <Link to={RoutePath.Home} className="text-lg font-semibold tracking-tight">
          ERC20 vault
        </Link>
        <span className="text-sm text-ink-muted">Midnight example</span>
      </div>
    </header>

    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <Outlet />
    </main>

    <footer className="border-t border-border-subtle px-6 py-4 text-center text-sm text-ink-muted">
      Bridging ERC20 assets to Midnight shielded UTXOs via the Signature Network.
    </footer>
  </div>
);
