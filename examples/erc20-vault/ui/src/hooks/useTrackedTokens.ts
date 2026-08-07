import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { type Address, erc20Abi, getAddress, isAddress } from "viem";

import { type EvmPublicClient, useEvmPublicClient } from "./useEvmPublicClient.ts";

/**
 * One ERC20 the user asked the app to follow, with whatever the token says
 * about itself.
 *
 * Every descriptive field is nullable and stays that way: `name`, `symbol` and
 * `decimals` are conventions of the ERC20 standard rather than requirements, a
 * token is free to implement none of them, and the address alone is enough to
 * read a balance. A null field renders as "Unknown" and an unknown `decimals`
 * leaves the balance in atomic units, which is the honest reading.
 */
export interface TrackedToken {
  /** The token contract, checksummed. */
  readonly address: Address;
  /** The token's `name()`, or null when it does not answer one. */
  readonly name: string | null;
  /** The token's `symbol()`, or null when it does not answer one. */
  readonly symbol: string | null;
  /** The token's `decimals()`, or null when it does not answer one. */
  readonly decimals: number | null;
}

/** The tracked ERC20 list, and the operations that change it. */
export interface TrackedTokens {
  /** The tracked tokens, in the order they were added. */
  readonly tokens: readonly TrackedToken[];
  /**
   * Start following the ERC20 at `address`, then read its metadata.
   *
   * Reports a rejected address (not an address at all, or already tracked) on
   * a toast, so the caller only has to decide whether to clear its input.
   *
   * @param address - The token address, as the user typed it.
   * @returns True when the token was added, false when it was rejected.
   */
  readonly track: (address: string) => boolean;
  /**
   * Stop following a token.
   *
   * @param address - The token to drop, as carried on its
   *   {@link TrackedToken}.
   */
  readonly untrack: (address: Address) => void;
}

/**
 * Read what one ERC20 says about itself.
 *
 * Each call is tolerated separately: `name`, `symbol` and `decimals` are
 * optional in the standard, and a token answering none of them is still
 * perfectly trackable by address.
 *
 * @param client - The chain client to read through.
 * @param address - The token contract.
 * @returns The token, with a null field wherever the call did not answer.
 */
async function readTrackedToken(client: EvmPublicClient, address: Address): Promise<TrackedToken> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => null),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
  ]);
  return { address, name, symbol, decimals };
}

/**
 * The ERC20s the user has asked the vault view to follow, and what each of them
 * says about itself.
 *
 * The vault handles any ERC20, and the contract's own state names none of them:
 * a token only becomes visible to a client once someone deposits it. There is
 * therefore nothing to enumerate, and the list is the user's own. It lives in
 * component state, so it is a session's worth of choices and a reload starts
 * over.
 *
 * @returns The list and the operations that change it.
 */
export function useTrackedTokens(): TrackedTokens {
  const client = useEvmPublicClient();
  const [addresses, setAddresses] = useState<readonly Address[]>([]);

  const track = useCallback(
    (address: string): boolean => {
      const typed = address.trim();
      if (!isAddress(typed)) {
        toast.error("Not an ERC20 address", {
          description: `"${typed}" is not a 20-byte EVM address. Paste the token contract's address, 0x and 40 hex digits.`,
        });
        return false;
      }
      const checksummed = getAddress(typed);
      if (addresses.includes(checksummed)) {
        toast.info("Already tracking that token", { description: checksummed });
        return false;
      }
      setAddresses((current) => [...current, checksummed]);
      return true;
    },
    [addresses],
  );

  const untrack = useCallback((address: Address): void => {
    setAddresses((current) => current.filter((tracked) => tracked !== address));
  }, []);

  // Keyed by the chain as well as the list: the same address is a different
  // token on a different chain, and the app's chain can be reconfigured.
  const metadataQuery = useQuery<readonly TrackedToken[]>({
    queryKey: ["erc20-metadata", client.chain.id, addresses],
    enabled: addresses.length > 0,
    queryFn: async () => Promise.all(addresses.map((address) => readTrackedToken(client, address))),
  });

  const tokens = useMemo<readonly TrackedToken[]>(() => {
    const describedIdx = new Map((metadataQuery.data ?? []).map((token) => [token.address, token]));
    // The address is what tracking IS, so a token appears the moment it is
    // added and its description fills in when the reads land.
    return addresses.map(
      (address) =>
        describedIdx.get(address) ?? { address, name: null, symbol: null, decimals: null },
    );
  }, [addresses, metadataQuery.data]);

  return useMemo<TrackedTokens>(() => ({ tokens, track, untrack }), [tokens, track, untrack]);
}
