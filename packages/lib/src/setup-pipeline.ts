import { getMidnightNodeConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

import { stepHeader } from "./output.ts";
import { waitForGo } from "./waitForGo.ts";

/**
 * One named setup step: the name is what the operator greps for and what
 * STEP_THROUGH prompts show; the function mutates the shared env accumulator
 * (presence of a step's canonical env var doubles as its skip signal) and
 * takes the pipeline's wallet registry, one started facade per role wallet
 * for the whole pipeline.
 */
export type SetupStep = readonly [
  name: string,
  run: (env: NodeJS.ProcessEnv, wallets: WalletRegistry) => void | Promise<void>,
];

/**
 * Run ordered setup steps and close every setup-owned wallet on success or failure.
 *
 * @param env - Accumulated deployment configuration.
 * @param steps - Ordered preparation steps.
 * @returns The populated configuration.
 * @throws {Error} When a preparation step fails.
 */
export async function executeSetupPipeline(
  env: NodeJS.ProcessEnv,
  steps: readonly SetupStep[],
): Promise<NodeJS.ProcessEnv> {
  const wallets = new WalletRegistry(getMidnightNodeConfig(env));
  try {
    for (const [index, [name, run]] of steps.entries()) {
      if (env.STEP_THROUGH && index > 0) await waitForGo(index + 1, steps.length, name);
      stepHeader(index + 1, steps.length, name);
      await run(env, wallets);
    }
    return env;
  } finally {
    await wallets.close();
  }
}
