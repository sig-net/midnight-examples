import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { erc20Abi, formatUnits, type Address } from "viem";

import { useMidnightWallet } from "../components/contexts";
import { describeError } from "../lib/errorMessage";
import { shortenAddress } from "../lib/shortenAddress";
import { useEvmPublicClient, type EvmPublicClient } from "./useEvmPublicClient.ts";
import type { TrackedToken } from "./useTrackedTokens";

/**
 * One asset an account holds, ready to render.
 *
 * Deliberately says nothing about which chain it came from: an EVM account's
 * ether and an ERC20 balance and a Midnight wallet's shielded token all reduce
 * to the same three things, and exactly one place should have to know how each
 * was read.
 */
export interface AssetBalance {
  /** Stable identity of the row, unique within one account's list. */
  readonly key: string;
  /** What the asset is called: a symbol where there is one, else its id. */
  readonly label: string;
  /** What tells this row from a similar one, or null when nothing needs to. */
  readonly detail: string | null;
  /** The amount, already scaled by the asset's decimals. */
  readonly amount: string;
}

/** One account's assets, and the state of the read that produced them. */
export interface AccountBalances {
  /** The assets held, empty until the first read lands. */
  readonly balances: readonly AssetBalance[];
  /** True while a read is in flight, including a refresh over shown balances. */
  readonly loading: boolean;
  /** Why the read failed, when it did. */
  readonly error: string | null;
  /** Read the balances again. */
  readonly refresh: () => void;
}

/**
 * What one EVM account holds, before anything is decided about how to show it.
 *
 * Amounts only: a token's own name and scale are read separately and land
 * later, and rows built here would still be carrying whatever was known at the
 * moment of the read (see {@link useEvmAccountBalances}).
 */
interface AccountHoldings {
  /** The chain's own currency, in wei. */
  readonly native: bigint;
  /**
   * Atomic units per tracked token, absent for a token that did not answer.
   */
  readonly tokens: Readonly<Record<Address, bigint>>;
}

/**
 * Read one ERC20's balance for an account.
 *
 * @param client - The chain client to read through.
 * @param token - The token contract to read.
 * @param account - The account holding it.
 * @returns The balance in atomic units, or null when the token did not answer.
 */
async function readTokenBalance(
  client: EvmPublicClient,
  token: Address,
  account: Address,
): Promise<bigint | null> {
  return client
    .readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    })
    .catch(() => null);
}

/**
 * The assets one EVM account holds: the chain's own currency, plus each
 * tracked ERC20.
 *
 * A token whose `balanceOf` does not answer is dropped from the list rather
 * than shown as zero: this view is read to decide whether a deposit landed, and
 * a failed read that looks like a balance is the one wrong answer it must never
 * give.
 *
 * @param account - The account to read, or null when there is none to read yet.
 * @param tokens - The ERC20s to read alongside the native balance.
 * @returns The balances and the state of the read.
 */
export function useEvmAccountBalances(
  account: Address | null,
  tokens: readonly TrackedToken[],
): AccountBalances {
  const client = useEvmPublicClient();
  const addresses = useMemo(() => tokens.map((token) => token.address), [tokens]);

  const query = useQuery<AccountHoldings>({
    queryKey: ["evm-account-balances", client.chain.id, account, addresses],
    enabled: account !== null,
    // A chain read is one round trip to one endpoint: worth a second attempt,
    // not worth the default's four before the view admits anything is wrong.
    retry: 1,
    queryFn: async () => {
      if (account === null) {
        throw new Error("Cannot read balances: no account.");
      }
      const [native, amounts] = await Promise.all([
        client.getBalance({ address: account }),
        Promise.all(addresses.map((address) => readTokenBalance(client, address, account))),
      ]);
      return {
        native,
        tokens: Object.fromEntries(
          addresses.flatMap((address, index) => {
            const amount = amounts[index];
            return amount === undefined || amount === null ? [] : [[address, amount] as const];
          }),
        ),
      };
    },
  });

  // Bound to the query's own refetch, which TanStack keeps stable across
  // renders: a refresh that changed identity every render would republish this
  // whole shape on every render with it.
  const { refetch } = query;
  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  // Naming and scaling happen HERE rather than in the query, so a token's
  // metadata landing after its balance still relabels the row it belongs to.
  // Baked into the query result, a balance read before `symbol()` answered
  // would keep calling the token by its address until something else forced a
  // refetch.
  const nativeCurrency = client.chain.nativeCurrency;
  const balances = useMemo<readonly AssetBalance[]>(() => {
    const holdings = query.data;
    if (holdings === undefined) {
      return [];
    }
    return [
      {
        key: "native",
        label: nativeCurrency.symbol,
        detail: null,
        amount: formatUnits(holdings.native, nativeCurrency.decimals),
      },
      ...tokens.flatMap((token) => {
        const amount = holdings.tokens[token.address];
        if (amount === undefined) {
          return [];
        }
        return [
          {
            key: token.address,
            // A token that answers no symbol is known by its address and
            // nothing else, so that is what the row calls it.
            label: token.symbol ?? shortenAddress(token.address),
            detail: token.symbol === null ? null : shortenAddress(token.address),
            // An unknown `decimals` leaves the amount in atomic units rather
            // than guessing 18: a wrong scale reads as a plausible number,
            // which is worse than an obviously raw one.
            amount: formatUnits(amount, token.decimals ?? 0),
          },
        ];
      }),
    ];
  }, [query.data, nativeCurrency, tokens]);

  return useMemo<AccountBalances>(
    () => ({
      balances,
      loading: query.isFetching,
      error: query.error === null ? null : describeError(query.error),
      refresh,
    }),
    [balances, query.isFetching, query.error, refresh],
  );
}

/**
 * The assets the connected Midnight wallet holds: every shielded and
 * unshielded token it reports, plus its dust.
 *
 * Amounts stay in the wallet's own atomic units, and a token is labelled by its
 * type. A Midnight token type is an opaque id with no metadata behind it: the
 * wallet has no decimals to scale by and no symbol to name it, so anything
 * prettier here would be invented rather than read.
 *
 * @returns The balances and the state of the read.
 */
export function useMidnightAccountBalances(): AccountBalances {
  const { wallet } = useMidnightWallet();

  const query = useQuery<readonly AssetBalance[]>({
    queryKey: ["midnight-account-balances", wallet === null ? null : wallet.id],
    enabled: wallet !== null,
    retry: 1,
    queryFn: async () => {
      if (wallet === null) {
        throw new Error("Cannot read balances: no Midnight wallet is connected.");
      }
      const [shielded, unshielded, dust] = await Promise.all([
        wallet.getShieldedBalances(),
        wallet.getUnshieldedBalances(),
        wallet.getDustBalance(),
      ]);
      return [
        ...Object.entries(shielded).map(([tokenType, amount]) => ({
          key: `shielded:${tokenType}`,
          label: tokenType,
          detail: "shielded",
          amount: amount.toString(),
        })),
        ...Object.entries(unshielded).map(([tokenType, amount]) => ({
          key: `unshielded:${tokenType}`,
          label: tokenType,
          detail: "unshielded",
          amount: amount.toString(),
        })),
        // Dust is neither: it is generated from the wallet's Night rather than
        // held as a token, so it comes with the ceiling that generation is
        // working towards. A wallet that reports no cap gets no cap row: an
        // invented ceiling would read as a balance that exists.
        { key: "dust", label: "Dust", detail: "spendable", amount: dust.balance.toString() },
        ...(dust.cap === null
          ? []
          : [{ key: "dust-cap", label: "Dust", detail: "cap", amount: dust.cap.toString() }]),
      ];
    },
  });

  // Bound to the query's own refetch, which TanStack keeps stable across
  // renders: a refresh that changed identity every render would republish this
  // whole shape on every render with it.
  const { refetch } = query;
  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return useMemo<AccountBalances>(
    () => ({
      balances: query.data ?? [],
      loading: query.isFetching,
      error: query.error === null ? null : describeError(query.error),
      refresh,
    }),
    [query.data, query.isFetching, query.error, refresh],
  );
}
