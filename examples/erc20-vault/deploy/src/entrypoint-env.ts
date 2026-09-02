// The environment a deploy entrypoint runs against, and the one guard the
// entrypoints owe an operator that the flows cannot give them: a flow sees a
// plain env map and cannot tell a value the operator exported for THIS run from
// one the local e2e pipeline appended to the repo-root `.env`.

import {
  buildBaseEnv,
  envOrUndefined,
  getMidnightNodeConfig,
  loadRepoDotEnv,
  type NetworkId,
} from "@sig-net/midnight-examples-lib";

// Values that only mean anything on the network that produced them. The e2e
// setup pipeline appends the first two to the repo-root `.env` on every local
// run and prints the rest for the operator to paste in, so on a working local
// stack the file legitimately holds local-chain values for all of them.
const NETWORK_SCOPED_KEYS = [
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "MPC_ROOT_KEY",
  "MPC_SECP256K1_PUBKEY",
  "MPC_RESPONSE_KEY",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "EVM_VAULT_ADDRESS",
] as const;

/**
 * The environment for a deploy entrypoint: the repo-root `.env` overlaid with
 * the real environment (which wins), checked against the network this run
 * targets.
 *
 * A vault deploy seals `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` into the contract as
 * a constructor argument, and `initialise` seals values derived from
 * `MPC_SECP256K1_PUBKEY`. Both are permanent. When the `.env` was written for a
 * different network than this run targets (the usual case: a local e2e run
 * populated it, and the operator now points a shell at a remote network), those
 * file values are silently wrong and would produce a contract that can never
 * work. Refuse instead, naming what to export.
 *
 * @returns The merged environment.
 * @throws {Error} If the repo-root `.env` names a different network and still supplies a
 *   network-scoped value this run has not overridden.
 */
export function buildEntrypointEnv(): NodeJS.ProcessEnv {
  const env = buildBaseEnv();
  assertEnvFileMatchesNetwork(loadRepoDotEnv(), process.env, getMidnightNodeConfig(env).networkId);
  return env;
}

/**
 * The check {@link buildEntrypointEnv} performs, over explicit inputs.
 *
 * @param fileEnv - What the repo-root `.env` holds.
 * @param processEnv - The real environment, whose values the operator set for THIS run.
 * @param networkId - The network this run resolved.
 * @throws {Error} If `fileEnv` names a different network and still supplies a network-scoped
 *   value `processEnv` has not overridden.
 */
export function assertEnvFileMatchesNetwork(
  fileEnv: Record<string, string | undefined>,
  processEnv: Record<string, string | undefined>,
  networkId: NetworkId,
): void {
  // Read the file's own NETWORK_ID rather than resolving a whole config from
  // it: the network name is the only thing being compared.
  const fileNetworkId = envOrUndefined(fileEnv, "NETWORK_ID") ?? "undeployed";
  if (fileNetworkId === networkId) return;

  const stale = NETWORK_SCOPED_KEYS.filter(
    (key) =>
      envOrUndefined(fileEnv, key) !== undefined && envOrUndefined(processEnv, key) === undefined,
  );
  if (stale.length === 0) return;

  throw new Error(
    `the repo-root .env holds ${stale.join(", ")} for "${fileNetworkId}", but this run targets ` +
      `"${networkId}". Those values are network-scoped and are sealed into the contract ` +
      "permanently, so export the ones belonging to this network (or remove them from .env) " +
      "rather than deploying against another network's values.",
  );
}
