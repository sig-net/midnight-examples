// Reading a Midnight node config OUT of a Node environment. The config shape
// itself, the per-network defaults and the pure URL derivation live in
// @midnight-examples/chain-config, which stays browser-safe: only the
// environment reading is here.

import {
  DEFAULT_ENDPOINTS,
  FAUCET_URLS,
  indexerWsUrlFromIndexerUrl,
  NETWORK_IDS,
  type MidnightNodeConfig,
  type NetworkId,
} from "@midnight-examples/chain-config";

/**
 * The faucet URL to show in underfunded-wallet hints: `MIDNIGHT_FAUCET_URL`
 * from the environment when set, else the network's {@link FAUCET_URLS}
 * entry. Purely informational — a missing URL only makes the hint generic.
 *
 * @param env - The environment to read `MIDNIGHT_FAUCET_URL` from.
 * @param networkId - The network whose faucet the hint points at.
 * @returns The faucet URL, or undefined when none is known.
 */
export function getFaucetUrl(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): string | undefined {
  return env.MIDNIGHT_FAUCET_URL?.trim() || FAUCET_URLS[networkId];
}

/**
 * Read a {@link MidnightNodeConfig} from the environment. With nothing set
 * this yields the local "undeployed" stack; a network with blank defaults
 * (stagenet — its endpoints are not published in this repo) REQUIRES the
 * endpoint variables and fails naming the missing ones.
 *
 * Parse flow:
 * 1. `NETWORK_ID` (default "undeployed", validated against `NETWORK_IDS`)
 *    selects the `DEFAULT_ENDPOINTS` baseline.
 * 2. Per-URL overrides then replace individual baseline endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`,
 *    `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it instead of keeping the baseline host.
 * 3. Every resolved endpoint must be non-empty.
 *
 * @param env - The environment to read from; defaults to `process.env`.
 * @returns The resolved node configuration.
 * @throws If `NETWORK_ID` is set to an unknown network id, or an endpoint
 *   resolves empty (blank default and no environment override).
 */
export function getMidnightNodeConfig(
  env: Record<string, string | undefined> = process.env,
): MidnightNodeConfig {
  const networkId: NetworkId = env.NETWORK_ID?.trim() || "undeployed";
  if (!NETWORK_IDS.includes(networkId)) {
    throw new Error(`Invalid NETWORK_ID "${networkId}" — expected one of: ${NETWORK_IDS.join(", ")}.`);
  }

  const defaults = DEFAULT_ENDPOINTS[networkId];
  const indexerUrl = env.MIDNIGHT_NODE_INDEXER_URL || defaults.indexerUrl;
  const indexerWsUrl =
    env.MIDNIGHT_NODE_INDEXER_WS_URL ||
    (env.MIDNIGHT_NODE_INDEXER_URL ? indexerWsUrlFromIndexerUrl(indexerUrl) : defaults.indexerWsUrl);

  const config: MidnightNodeConfig = {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl: env.MIDNIGHT_NODE_URL || defaults.nodeUrl,
    proofServerUrl: env.MIDNIGHT_NODE_PROOF_SERVER_URL || defaults.proofServerUrl,
  };

  // A blank default means the network's endpoints are not published in this
  // repo (stagenet) — the environment must supply them, so fail with the
  // exact variables to set.
  const missing: string[] = [];
  if (!config.nodeUrl) missing.push("MIDNIGHT_NODE_URL");
  if (!config.indexerUrl) missing.push("MIDNIGHT_NODE_INDEXER_URL");
  if (!config.indexerWsUrl) missing.push("MIDNIGHT_NODE_INDEXER_WS_URL");
  if (!config.proofServerUrl) missing.push("MIDNIGHT_NODE_PROOF_SERVER_URL");
  if (missing.length > 0) {
    throw new Error(
      `network "${networkId}" has no built-in endpoints in this repo — set ${missing.join(", ")} ` +
        `in the environment (or the repo-root .env).`,
    );
  }

  return config;
}
