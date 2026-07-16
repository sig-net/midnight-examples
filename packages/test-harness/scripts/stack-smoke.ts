// Smoke check of the local docker stack: bring the compose services up,
// wait until every endpoint answers, then tear the stack down again.
// Verifies docker-compose.yaml and the harness preflight agree on the
// stack's shape without running any protocol traffic. Run via
// `yarn workspace @midnight-examples/test-harness smoke:stack`.
//
// NOTE: `docker compose down` DESTROYS the containers — and with them the
// dev chain's state (deployed contracts, funded accounts). This script is
// for verifying the stack machinery, not for managing a stack you are
// testing against.

import { getMidnightNodeConfig } from "@midnight-examples/lib";
import { buildBaseEnv } from "../src/e2e-env.ts";
import { getEvmChainId } from "../src/evm.ts";
import { runCommand } from "../src/exec.ts";
import { assertHttpReachable } from "../src/preflight.ts";

const MINUTE = 60_000;

/**
 * Retry `probe` until it stops throwing or `timeoutMs` passes — fresh
 * containers need a few seconds before their endpoints answer.
 *
 * @param name - What is being probed, for the giving-up error message.
 * @param probe - The reachability check to repeat.
 * @param timeoutMs - Give-up timeout.
 * @throws The probe's last error once the timeout passes.
 */
async function waitUntilReachable(name: string, probe: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      console.log(`${name}: reachable`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

const env = buildBaseEnv();
const nodeConfig = getMidnightNodeConfig(env);
const evmRpcUrl = env.EVM_RPC_URL ?? "http://127.0.0.1:8545";

console.log("bringing the compose stack up (node, indexer, proof server, EVM — fakenet is profile-gated) …");
await runCommand("docker", ["compose", "up", "-d"], env, 10 * MINUTE);

try {
  await waitUntilReachable(
    "midnight node",
    () => assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href),
    2 * MINUTE,
  );
  await waitUntilReachable("indexer", () => assertHttpReachable("indexer", nodeConfig.indexerUrl), 2 * MINUTE);
  await waitUntilReachable(
    "proof server",
    () => assertHttpReachable("proof server", nodeConfig.proofServerUrl),
    2 * MINUTE,
  );
  await waitUntilReachable(
    "EVM node",
    async () => {
      const chainId = await getEvmChainId(evmRpcUrl);
      console.log(`EVM node reports chain id ${chainId}`);
    },
    2 * MINUTE,
  );
} finally {
  console.log("tearing the compose stack down …");
  await runCommand("docker", ["compose", "down"], env, 5 * MINUTE);
}

console.log("stack smoke check passed: up, reachable, down.");
