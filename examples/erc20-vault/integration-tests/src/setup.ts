import { vaultSetupSteps } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { runSetupPipeline } from "@sig-net/midnight-examples-test-harness";
import type { TestProject } from "vitest/node";
/**
 * Prepare the vault stack for integration-test workers.
 *
 * @param project - Vitest project receiving the setup configuration.
 * @throws {Error} When setup fails.
 */
export async function setup(project: TestProject): Promise<void> {
  await runSetupPipeline(project, vaultSetupSteps());
}
