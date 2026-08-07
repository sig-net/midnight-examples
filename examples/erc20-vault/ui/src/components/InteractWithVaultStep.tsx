import { RefreshCwIcon, XIcon } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { isAddress, type Address } from "viem";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useERC20Vault, useEVMWallet, useMidnightWallet } from "./contexts";
import {
  useEvmAccountBalances,
  useMidnightAccountBalances,
  type AccountBalances,
  type AssetBalance,
} from "../hooks/useAccountBalances";
import { useTrackedTokens, type TrackedToken, type TrackedTokens } from "../hooks/useTrackedTokens";
import { useVaultEvmAddress } from "../hooks/useVaultEvmAddress";
import { shortenAddress } from "../lib/shortenAddress";

/** What a token that answers no `name()` or `symbol()` is called instead. */
const UNKNOWN_METADATA = "Unknown";

/** Props of {@link TrackedTokenRow}. */
interface TrackedTokenRowProps {
  readonly token: TrackedToken;
  readonly onUntrack: (address: Address) => void;
}

/**
 * One tracked ERC20: what it is, and the control that drops it.
 *
 * @param props - The token and the drop action.
 * @returns The row.
 */
const TrackedTokenRow = ({ token, onUntrack }: TrackedTokenRowProps): JSX.Element => (
  <li className="flex items-center gap-3">
    <code className="shrink-0 font-mono text-xs">{shortenAddress(token.address)}</code>
    <span className={`min-w-0 flex-1 truncate ${token.name === null ? "text-muted-foreground" : ""}`}>
      {token.name ?? UNKNOWN_METADATA}
    </span>
    <span className={`min-w-0 flex-1 truncate ${token.symbol === null ? "text-muted-foreground" : ""}`}>
      {token.symbol ?? UNKNOWN_METADATA}
    </span>
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={`Stop tracking ${token.address}`}
      onClick={() => {
        onUntrack(token.address);
      }}
    >
      <XIcon className="size-3.5" aria-hidden="true" />
    </Button>
  </li>
);

/** Props of {@link TrackedTokensSection}. */
interface TrackedTokensSectionProps {
  readonly tracked: TrackedTokens;
}

/**
 * The ERC20s the balances below are read for, and the control that adds one.
 *
 * The vault handles any ERC20 and its ledger names none of them, so there is no
 * list to offer: which tokens matter is the user's own answer, typed in as
 * addresses. A rejected address is reported on a toast by the hook, and the
 * field only clears when the token was actually taken.
 *
 * @param props - The tracked-token list and its operations.
 * @returns The section.
 */
const TrackedTokensSection = ({ tracked }: TrackedTokensSectionProps): JSX.Element => {
  const [typedAddress, setTypedAddress] = useState("");

  return (
    <section aria-label="Tracked ERC20 assets" className="flex flex-col gap-3">
      <h2 className="font-medium">Select ERC20 assets to track</h2>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (tracked.track(typedAddress)) {
            setTypedAddress("");
          }
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="track-erc20" className="text-muted-foreground">
            Enter ERC20 tokens to track
          </label>
          <Input
            id="track-erc20"
            value={typedAddress}
            onChange={(event) => {
              setTypedAddress(event.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <Button type="submit" size="sm" disabled={typedAddress.trim() === ""}>
          Track
        </Button>
      </form>

      {tracked.tokens.length === 0 ? (
        <p className="text-muted-foreground">
          No assets tracked yet. Add an ERC20 address to see it in every balance below.
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-1">
          {tracked.tokens.map((token) => (
            <TrackedTokenRow key={token.address} token={token} onUntrack={tracked.untrack} />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Props of {@link AssetBalanceRow}. */
interface AssetBalanceRowProps {
  readonly balance: AssetBalance;
}

/**
 * One asset a balance panel lists: how much, and of what.
 *
 * @param props - The balance to render.
 * @returns The row.
 */
const AssetBalanceRow = ({ balance }: AssetBalanceRowProps): JSX.Element => (
  <li className="flex items-baseline gap-2">
    <span className="font-mono">{balance.amount}</span>
    <span className="min-w-0 break-all">{balance.label}</span>
    {balance.detail === null ? null : (
      <span className="shrink-0 text-xs text-muted-foreground">{balance.detail}</span>
    )}
  </li>
);

/** Props of {@link BalancesPanel}. */
interface BalancesPanelProps {
  /** Whose balances these are: names the panel and its refresh control. */
  readonly title: string;
  /** The account, when there is an address form of it to show. */
  readonly address: string | null;
  /** Why there is nothing to read, when there is nothing to read. */
  readonly unavailable: string | null;
  /** The balances themselves. */
  readonly balances: AccountBalances;
}

/**
 * One account's balances, under its own heading and refresh control.
 *
 * Every account in the vault flow gets the same panel, whichever chain it is
 * on: the hooks have already reduced an EVM account's ether, an ERC20 balance
 * and a Midnight wallet's shielded tokens to one shape, and this renders that
 * shape and nothing else.
 *
 * @param props - The account, its balances, and any reason there are none.
 * @returns The panel.
 */
const BalancesPanel = ({
  title,
  address,
  unavailable,
  balances,
}: BalancesPanelProps): JSX.Element => (
  <section aria-label={`${title} balances`} className="flex flex-col gap-2 border-t border-border pt-3">
    <div className="flex items-center gap-2">
      <h2 className="min-w-0 truncate font-medium">{title}</h2>
      {address === null ? null : (
        <code className="shrink-0 font-mono text-xs text-muted-foreground">
          {shortenAddress(address)}
        </code>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-7 shrink-0"
        aria-label={`Refresh ${title} balances`}
        onClick={balances.refresh}
        disabled={unavailable !== null || balances.loading}
      >
        <RefreshCwIcon
          className={`size-3.5 ${balances.loading ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
      </Button>
    </div>

    {unavailable !== null ? (
      <p className="text-muted-foreground">{unavailable}</p>
    ) : balances.error !== null ? (
      <p className="text-destructive">{balances.error}</p>
    ) : balances.balances.length === 0 ? (
      <p className="text-muted-foreground">
        {balances.loading ? "Reading balances…" : "No balances to show."}
      </p>
    ) : (
      <ul className="flex list-none flex-col gap-1">
        {balances.balances.map((balance) => (
          <AssetBalanceRow key={balance.key} balance={balance} />
        ))}
      </ul>
    )}
  </section>
);

/**
 * The vault-interaction step's VIEW-AREA body: every account the flow touches,
 * and what each of them holds.
 *
 * A deposit moves ERC20 value from the caller's own derived account into the
 * vault's, and mints a shielded token on Midnight against it; a withdrawal runs
 * the same path backwards. Four accounts therefore decide whether any of it
 * worked, and they sit on two chains: the EVM wallet that funds a deposit, the
 * caller's derived deposit address, the vault's own EVM account, and the
 * Midnight wallet holding the minted tokens. They are read side by side here
 * because that is how they are compared.
 *
 * @returns The view's body.
 */
export const InteractWithVaultView = (): JSX.Element => {
  const { wallet: evmWallet } = useEVMWallet();
  const account = evmWallet?.account ?? null;
  const { wallet } = useMidnightWallet();
  const { identity } = useERC20Vault();
  const tracked = useTrackedTokens();
  const vaultEvmAddress = useVaultEvmAddress();

  // `deriveEvmAddress` returns a checksummed address, so the guard only
  // narrows the string to viem's `Address`; it never rejects a derived one.
  const depositAddress = useMemo<Address | null>(() => {
    const derived = identity?.depositEvmAddress ?? null;
    return derived !== null && isAddress(derived) ? derived : null;
  }, [identity]);

  // The two ways there is no deposit address to read read differently: no
  // identity yet is a step still to do, while an identity whose address will
  // not derive is a missing configuration only the operator can fix.
  const depositUnavailable =
    depositAddress !== null
      ? null
      : identity === null
        ? "Derive your deposit address first, in the step before this one."
        : "VITE_MPC_ROOT_PUBLIC_KEY is not set, so the deposit address cannot be derived.";

  const evmWalletBalances = useEvmAccountBalances(account, tracked.tokens);
  const depositBalances = useEvmAccountBalances(depositAddress, tracked.tokens);
  const vaultBalances = useEvmAccountBalances(vaultEvmAddress.address, tracked.tokens);
  const midnightBalances = useMidnightAccountBalances();

  return (
    <div className="flex flex-col gap-6 text-sm">
      <p className="text-muted-foreground">
        Every account a deposit or a withdrawal moves value between, on both chains. The ERC20s
        tracked here are the ones each EVM balance is read for.
      </p>

      <TrackedTokensSection tracked={tracked} />

      <BalancesPanel
        title="EVM browser wallet"
        address={account}
        unavailable={account === null ? "Connect the EVM wallet to read its balances." : null}
        balances={evmWalletBalances}
      />

      <BalancesPanel
        title="Your deposit address"
        address={depositAddress}
        unavailable={depositUnavailable}
        balances={depositBalances}
      />

      <BalancesPanel
        title="Vault address"
        address={vaultEvmAddress.address}
        unavailable={vaultEvmAddress.unavailable}
        balances={vaultBalances}
      />

      <BalancesPanel
        title="Midnight wallet"
        address={null}
        unavailable={
          wallet === null ? "Connect the Midnight wallet to read its balances." : null
        }
        balances={midnightBalances}
      />
    </div>
  );
};
