// Reading a Midnight node config OUT of a Node environment. The config shape
// itself, the per-network defaults and the pure URL derivation live in
// @midnight-examples/chain-config, which stays browser-safe: only the
// environment reading is here.

import {
  DEFAULT_ENDPOINTS,
  FAUCET_URLS,
  indexerWsUrlFromIndexerUrl,
  isNetworkId,
  type MidnightNodeConfig,
  NETWORK_IDS,
} from "@midnight-examples/chain-config";

import { envOrUndefined } from "./env.ts";

/**
 * The faucet URL to show in underfunded-wallet hints: `MIDNIGHT_FAUCET_URL`
 * from the environment when set, else the network's {@link FAUCET_URLS}
 * entry. Purely informational — a missing URL only makes the hint generic.
 *
 * Takes a bare `string` rather than a {@link NetworkId} because callers reach
 * it holding a network id from the deploy SDK, which types its own as a plain
 * string. An unrecognised name simply has no {@link FAUCET_URLS} entry, which
 * is the same generic-hint outcome as a network that publishes no faucet.
 *
 * @param env - The environment to read `MIDNIGHT_FAUCET_URL` from.
 * @param networkId - The network whose faucet the hint points at.
 * @returns The faucet URL, or undefined when none is known.
 */
export function getFaucetUrl(
  env: Record<string, string | undefined>,
  networkId: string,
): string | undefined {
  const known = isNetworkId(networkId) ? FAUCET_URLS[networkId] : undefined;
  return envOrUndefined(env, "MIDNIGHT_FAUCET_URL") ?? known;
}

/**
 * Read a {@link MidnightNodeConfig} from the environment. With nothing set
 * this yields the local "undeployed" stack; a network with blank defaults
 * (stagenet — its endpoints are not published in this repo) REQUIRES the
 * endpoint variables and fails naming the missing ones.
 *
 * Parse flow:
 * 1. `MIDNIGHT_NETWORK_ID` (default "undeployed", validated against
 *    `NETWORK_IDS`) selects the `DEFAULT_ENDPOINTS` baseline.
 * 2. Per-URL overrides then replace individual baseline endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_INDEXER_URL`,
 *    `MIDNIGHT_INDEXER_WS_URL`, `MIDNIGHT_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it instead of keeping the baseline host.
 * 3. Every resolved endpoint must be non-empty.
 *
 * @param env - The environment to read from; defaults to `process.env`.
 * @returns The resolved node configuration.
 * @throws {Error} If `MIDNIGHT_NETWORK_ID` is set to an unknown network id, or
 *   an endpoint resolves empty (blank default and no environment override).
 */
export function getMidnightNodeConfig(
  env: Record<string, string | undefined> = process.env,
): MidnightNodeConfig {
  const networkId = envOrUndefined(env, "MIDNIGHT_NETWORK_ID") ?? "undeployed";
  if (!isNetworkId(networkId)) {
    throw new Error(
      `Invalid MIDNIGHT_NETWORK_ID "${networkId}" — expected one of: ${NETWORK_IDS.join(", ")}.`,
    );
  }

  const defaults = DEFAULT_ENDPOINTS[networkId];
  const indexerUrlOverride = envOrUndefined(env, "MIDNIGHT_INDEXER_URL");
  const indexerUrl = indexerUrlOverride ?? defaults.indexerUrl;
  const indexerWsUrl =
    envOrUndefined(env, "MIDNIGHT_INDEXER_WS_URL") ??
    (indexerUrlOverride === undefined
      ? defaults.indexerWsUrl
      : indexerWsUrlFromIndexerUrl(indexerUrl));

  const config: MidnightNodeConfig = {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl: envOrUndefined(env, "MIDNIGHT_NODE_URL") ?? defaults.nodeUrl,
    proofServerUrl: envOrUndefined(env, "MIDNIGHT_PROOF_SERVER_URL") ?? defaults.proofServerUrl,
  };

  // A blank default means the network's endpoints are not published in this
  // repo (stagenet) — the environment must supply them, so fail with the
  // exact variables to set.
  const missing: string[] = [];
  if (!config.nodeUrl) missing.push("MIDNIGHT_NODE_URL");
  if (!config.indexerUrl) missing.push("MIDNIGHT_INDEXER_URL");
  if (!config.indexerWsUrl) missing.push("MIDNIGHT_INDEXER_WS_URL");
  if (!config.proofServerUrl) missing.push("MIDNIGHT_PROOF_SERVER_URL");
  if (missing.length > 0) {
    throw new Error(
      `network "${networkId}" has no built-in endpoints in this repo — set ${missing.join(", ")} ` +
        `in the environment (or the repo-root .env).`,
    );
  }

  return config;
}
