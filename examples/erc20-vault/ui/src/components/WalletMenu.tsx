import { CheckIcon, LoaderCircleIcon, WalletIcon } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * One wallet the user could connect: `id` is the handle to connect by, the rest
 * is what makes it recognisable in the list.
 *
 * The two chains identify wallets by different things (a wagmi `uid`, a
 * `window.midnight` key), which is exactly why this is an opaque `id` here: the
 * menu passes it back untouched and never interprets it.
 */
export interface WalletChoice {
  readonly id: string;
  readonly name: string;
  /** The wallet's own icon, as a URL or data URL, when it published one. */
  readonly iconUrl: string | undefined;
}

/** The connected wallet, as much of it as the menu shows. */
export interface ConnectedWallet {
  readonly name: string;
  readonly iconUrl: string | undefined;
  /** A second line under the name: an address, a network, whatever identifies it. */
  readonly detail: string | undefined;
}

/** Props of {@link WalletMenu}. */
export interface WalletMenuProps {
  /** The chain this wallet is for, named in the label and the menu heading. */
  readonly chainName: string;
  /** The connected wallet, or null while none is. */
  readonly connected: ConnectedWallet | null;
  /** True while a connection prompt is outstanding. */
  readonly connecting: boolean;
  /** The wallets available to connect. */
  readonly choices: readonly WalletChoice[];
  /**
   * Called when the menu opens or closes, for a chain whose wallet list has to
   * be re-read at that moment. Omitted by a chain that publishes its list
   * reactively and so has nothing to refresh.
   */
  readonly onOpenChange?: (open: boolean) => void;
  /** Called with a {@link WalletChoice.id} when the user picks a wallet. */
  readonly onConnect: (walletId: string) => void;
  /** Called when the user disconnects. */
  readonly onDisconnect: () => void;
}

/** Props of {@link WalletMark}. */
interface WalletMarkProps {
  readonly iconUrl: string | undefined;
  readonly muted: boolean;
}

/**
 * A wallet's own icon, falling back to a generic one when it published none.
 *
 * Rendered as an `img` source and never as markup: both connector APIs hand out
 * an icon the EXTENSION controls, and the Midnight one documents the XSS risk
 * in as many words. An `img` cannot execute what it is pointed at.
 *
 * Decorative in both places it appears, so its `alt` is empty by design: in the
 * trigger the button's own `aria-label` is the name, and in a menu item the
 * wallet's name follows as text.
 *
 * @param props - The icon to show, and whether to wash it out.
 * @returns The mark, sized to sit inside a button.
 */
const WalletMark = ({ iconUrl, muted }: WalletMarkProps): JSX.Element => {
  if (iconUrl === undefined) {
    return <WalletIcon className={muted ? "opacity-60" : undefined} aria-hidden="true" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={`size-4 rounded-sm ${muted ? "opacity-60 grayscale" : ""}`}
    />
  );
};

/**
 * One chain's wallet control: an icon in the header that shows at a glance
 * whether that chain is connected, and opens a menu to connect or disconnect.
 *
 * Presentational and chain-agnostic. The wallet-shaped work (which contexts to
 * read, how to surface a failure) belongs to the adapters that wrap this, one
 * per chain, since the two connector APIs agree on nothing but the concept.
 *
 * @param props - The chain, its connection state, and the callbacks that change it.
 * @returns The trigger and its menu.
 */
export const WalletMenu = ({
  chainName,
  connected,
  connecting,
  choices,
  onOpenChange,
  onConnect,
  onDisconnect,
}: WalletMenuProps): JSX.Element => {
  const isConnected = connected !== null;

  // The whole state, in the accessible name. A screen reader gets what the
  // colour of the dot conveys to everyone else, and the tests have something
  // stable to query that is not a test id.
  const status = connecting ? "connecting" : isConnected ? "connected" : "not connected";
  const label = `${chainName} wallet: ${status}`;

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          // Washed out until connected, full strength once it is.
          className={isConnected ? undefined : "text-muted-foreground"}
        >
          {connecting ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <WalletMark iconUrl={connected?.iconUrl} muted={!isConnected} />
          )}
          {/* The chain, on the control itself. Two wallet glyphs side by side
              are indistinguishable without it, and which chain is connected is
              the entire question this control answers. It drops below `sm`,
              where the accessible name and the tooltip still carry it. */}
          <span className="hidden sm:inline">{chainName}</span>
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              isConnected ? "bg-emerald-500" : "bg-muted-foreground/50 ring-1 ring-border"
            }`}
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{chainName} wallet</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {connected === null ? (
          choices.length === 0 ? (
            <DropdownMenuItem disabled>
              No {chainName} wallet extension found
            </DropdownMenuItem>
          ) : (
            choices.map((choice) => (
              <DropdownMenuItem
                key={choice.id}
                disabled={connecting}
                onSelect={() => {
                  onConnect(choice.id);
                }}
              >
                <WalletMark iconUrl={choice.iconUrl} muted={false} />
                Connect {choice.name}
              </DropdownMenuItem>
            ))
          )
        ) : (
          <>
            <DropdownMenuItem disabled className="opacity-100">
              <CheckIcon className="text-emerald-500" aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{connected.name}</span>
                {connected.detail === undefined ? null : (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {connected.detail}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                onDisconnect();
              }}
            >
              Disconnect
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
