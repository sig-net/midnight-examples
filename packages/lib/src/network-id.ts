// Network identity — the single source of named network ids.
//
// midnight-js types a network id as a bare `string` with no companion enum, so
// the named values live here. Convention: a network id is ALWAYS named
// `networkId` and ALWAYS typed `NetworkId`. Keeping this a literal union (and
// NOT widening it with the SDK's bare-string alias) is what makes
// DEFAULT_ENDPOINTS exhaustive and {@link isNetworkId} a real gate.

/** A Midnight network id: one of the named networks this repo knows. */
export type NetworkId =
  // Local standalone stack (Docker node + indexer + proof server on localhost).
  | "undeployed"
  // Public staging network, pre-preview.
  | "stagenet"
  // Public test network for early/breaking changes — bleeding-edge ledger.
  | "preview"
  // Public test network that mirrors mainnet config; the final staging step.
  | "preprod"
  // Production network (live, real value).
  | "mainnet";

/** All known network ids, for runtime validation and iteration. */
export const NETWORK_IDS: readonly NetworkId[] = [
  "undeployed",
  "stagenet",
  "preview",
  "preprod",
  "mainnet",
];

/**
 * Whether `value` names one of the {@link NETWORK_IDS}. The type predicate is
 * the only supported way into {@link NetworkId} from arbitrary input (an
 * environment variable, a CLI argument), so a caller cannot skip validation
 * and still typecheck.
 *
 * @param value - The candidate network name.
 * @returns Whether `value` is a known network id.
 */
export function isNetworkId(value: string): value is NetworkId {
  return (NETWORK_IDS as readonly string[]).includes(value);
}

/**
 * Whether a network's genesis mint wallet is pre-funded. TRUE only for the
 * local standalone chain (`undeployed`), whose genesis block mints to the
 * well-known genesis seed. Every deployed network (stagenet / preview /
 * preprod / mainnet) starts each wallet at zero, so a run against one needs
 * a seed funded out of band (via that network's faucet).
 *
 * @param networkId - The network to classify.
 * @returns Whether the genesis mint wallet holds spendable funds here.
 */
export function isLocalStandaloneNetwork(networkId: NetworkId): boolean {
  return networkId === "undeployed";
}
