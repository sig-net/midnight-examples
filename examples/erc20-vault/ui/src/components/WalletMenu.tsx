import { CheckIcon, LoaderCircleIcon } from "lucide-react";
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

import type { WalletConnection } from "../hooks/useWalletConnections";
import { WalletMark } from "./WalletMark";

/** Props of {@link WalletMenu}. */
export interface WalletMenuProps {
  /** One chain's connection, from `useMidnightWalletConnection` or its EVM twin. */
  readonly connection: WalletConnection;
}

/**
 * One chain's wallet control in the header: an icon that shows at a glance
 * whether that chain is connected, and a menu to connect or disconnect.
 *
 * Presentational and chain-agnostic. Everything chain-shaped (which context to
 * read, how a failure is surfaced) lives in the hook behind `connection`, since
 * the two connector APIs agree on nothing but the concept.
 *
 * @param props - The chain's connection.
 * @returns The trigger and its menu.
 */
export const WalletMenu = ({ connection }: WalletMenuProps): JSX.Element => {
  const { chainName, connected, connecting, choices, refreshChoices, connect, disconnect } =
    connection;
  const isConnected = connected !== null;

  // The whole state, in the accessible name. A screen reader gets what the
  // colour of the dot conveys to everyone else, and the tests have something
  // stable to query that is not a test id.
  const status = connecting ? "connecting" : isConnected ? "connected" : "not connected";
  const label = `${chainName} wallet: ${status}`;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          refreshChoices();
        }
      }}
    >
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
            <DropdownMenuItem disabled>No {chainName} wallet extension found</DropdownMenuItem>
          ) : (
            choices.map((choice) => (
              <DropdownMenuItem
                key={choice.id}
                disabled={connecting}
                onSelect={() => {
                  connect(choice.id);
                }}
              >
                <WalletMark iconUrl={choice.iconUrl} />
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
                disconnect();
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
