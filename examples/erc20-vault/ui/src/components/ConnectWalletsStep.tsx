import { CheckCircle2Icon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { WalletConnection } from "../hooks/useWalletConnections";
import { WalletMark } from "./WalletMark";

/** Props of {@link ConnectWalletRow}. */
interface ConnectWalletRowProps {
  readonly connection: WalletConnection;
}

/**
 * One chain's line in the connect step: connect it, or show that it is done.
 *
 * A connected row stops being a control. Leaving a "Connect Lace" button
 * sitting there once Lace IS connected invites a click that would do nothing,
 * so the row becomes a statement instead, and disconnecting stays in the header
 * where it does not compete with the step's forward motion.
 *
 * @param props - The chain's connection.
 * @returns The row.
 */
const ConnectWalletRow = ({ connection }: ConnectWalletRowProps): JSX.Element => {
  const { chainName, connected, connecting, choices, refreshChoices, connect } = connection;

  const tick =
    connected === null ? (
      <CircleIcon
        className="ml-auto size-4 shrink-0 text-muted-foreground/40"
        aria-hidden="true"
      />
    ) : (
      <CheckCircle2Icon className="ml-auto size-4 shrink-0 text-emerald-500" aria-hidden="true" />
    );

  if (connected !== null) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-sm">
        <WalletMark iconUrl={connected.iconUrl} />
        <span className="min-w-0 truncate">{connected.name}</span>
        {tick}
      </div>
    );
  }

  if (connecting) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 truncate">Connecting {chainName}…</span>
        {tick}
      </div>
    );
  }

  // Nothing announced itself for this chain. Not a control: there is nothing to
  // connect to until an extension is installed.
  if (choices.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
        <WalletMark iconUrl={undefined} muted />
        <span className="min-w-0 truncate">No {chainName} wallet found</span>
        {tick}
      </div>
    );
  }

  // Exactly one wallet is the ordinary case, and it deserves one click rather
  // than a menu of one.
  if (choices.length === 1) {
    const only = choices[0]!;
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start px-2 font-normal"
        onClick={() => {
          connect(only.id);
        }}
      >
        <WalletMark iconUrl={only.iconUrl} />
        <span className="min-w-0 truncate">Connect {only.name}</span>
        {tick}
      </Button>
    );
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          refreshChoices();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start px-2 font-normal">
          <WalletMark iconUrl={undefined} muted />
          {/* No article before the chain: "a Midnight wallet" and "an EVM
              wallet" disagree, and deriving the article from a chain name is a
              trick waiting to be got wrong by the next chain. */}
          <span className="min-w-0 truncate">Connect {chainName} wallet</span>
          {tick}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onSelect={() => {
              connect(choice.id);
            }}
          >
            <WalletMark iconUrl={choice.iconUrl} />
            Connect {choice.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Props of {@link ConnectWalletsStep}. */
export interface ConnectWalletsStepProps {
  /** Every wallet the app needs, in the order to connect them. */
  readonly connections: readonly WalletConnection[];
}

/**
 * The body of step one: one row per chain, each connectable until it is
 * connected.
 *
 * Both rows are always shown, connected or not. The step's whole message is
 * that the app needs TWO wallets, and a list that hid the ones already done
 * would keep resetting what the user thinks is being asked of them.
 *
 * @param props - The connections to list.
 * @returns The rows.
 */
export const ConnectWalletsStep = ({ connections }: ConnectWalletsStepProps): JSX.Element => (
  <div className="-mx-2 flex flex-col">
    {connections.map((connection) => (
      <ConnectWalletRow key={connection.chainName} connection={connection} />
    ))}
  </div>
);
