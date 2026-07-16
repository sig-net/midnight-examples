// The example's test-token deploy callback for the harness's
// `ensureErc20Deployed` step: compile contracts/TestUSDC.sol with hardhat
// (this package's compiler, this package's artifact path), then deploy it
// through the harness's generic `deployEvmContract`. Only ever invoked on
// the local dev chain.

import { readFileSync } from "node:fs";

import {
  deployEvmContract,
  requireEnv,
  runCommand,
  type EvmContractArtifact,
} from "@midnight-examples/test-harness";

const MINUTE = 60_000;

// The hh3-artifact-1 output of `yarn compile:evm` (hardhat).
const TEST_USDC_ARTIFACT_URL = new URL(
  "../artifacts/contracts/TestUSDC.sol/TestUSDC.json",
  import.meta.url,
);

/**
 * Compile and deploy {@link file://../contracts/TestUSDC.sol TestUSDC} to the
 * local dev chain from the dev funder account.
 *
 * @param env - The suite's env accumulator (`EVM_RPC_URL`).
 * @returns The deployed token's address.
 * @throws If the hardhat compile fails, the artifact is missing afterwards,
 *   or the deployment fails.
 */
export async function deployTestUsdc(env: NodeJS.ProcessEnv): Promise<string> {
  await runCommand(
    "yarn",
    ["workspace", "@midnight-examples/erc20-vault-integration-tests", "compile:evm"],
    env,
    2 * MINUTE,
  );

  let artifactJson: string;
  try {
    artifactJson = readFileSync(TEST_USDC_ARTIFACT_URL, "utf8");
  } catch (error) {
    throw new Error(
      `TestUSDC artifact not found at ${TEST_USDC_ARTIFACT_URL.pathname} after \`compile:evm\``,
      { cause: error },
    );
  }
  const artifact = JSON.parse(artifactJson) as EvmContractArtifact;
  return deployEvmContract(requireEnv(env, "EVM_RPC_URL"), artifact);
}
