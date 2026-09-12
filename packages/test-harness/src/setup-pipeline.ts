import "./provided-context.ts";

import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import { executeSetupPipeline, type SetupStep } from "@sig-net/midnight-examples-lib";
import type { TestProject } from "vitest/node";
/**
 * Provide prepared configuration to integration-test workers when explicitly enabled.
 *
 * @param project - Vitest project receiving the configuration.
 * @param steps - Ordered setup steps shared with deployment commands.
 * @throws {Error} When a setup step fails.
 */
export async function runSetupPipeline(
  project: TestProject,
  steps: readonly SetupStep[],
): Promise<void> {
  if (!process.env.RUN_INTEGRATION_TESTS) return;
  const env = await executeSetupPipeline(buildBaseEnv(), steps);
  project.provide(
    "e2eEnv",
    Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );
}
