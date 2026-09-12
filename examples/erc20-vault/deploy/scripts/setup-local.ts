import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { buildBaseEnv, REPO_ROOT } from "@sig-net/midnight-examples-lib";
import { runRootScript } from "@sig-net/midnight-examples-lib";

import { assertLocalRelease, verifyLocalArtifacts } from "../src/local-artifacts.ts";
const privateDirectory = resolve(REPO_ROOT, ".local-demo");
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const lockPath = resolve(privateDirectory, "setup.lock");
let lock: number;
try {
  lock = openSync(lockPath, "wx", 0o600);
} catch {
  throw new Error(
    "Local setup is locked. Wait for its process to finish. Remove .local-demo/setup.lock only after confirming an interrupted setup has stopped.",
  );
}
writeFileSync(lock, String(process.pid));
closeSync(lock);
try {
  const { values } = parseArgs({
    options: { "ui-directory": { type: "string" }, "reset-config": { type: "boolean" } },
  });
  const env = buildBaseEnv();
  delete env.SEPOLIA_FORK_RPC_URL;
  const uiDirectory = values["ui-directory"] ?? resolve(REPO_ROOT, "../full-stack-demo-deployment");
  assertLocalRelease(uiDirectory);
  try {
    verifyLocalArtifacts(uiDirectory);
  } catch {
    await runRootScript("compile:erc20-vault:zk", env, 20 * 60_000);
    verifyLocalArtifacts(uiDirectory);
  }
  const { setupLocalVault, resetLocalConfiguration } = await import("../src/setup-local.ts");
  if (values["reset-config"]) await resetLocalConfiguration();
  await setupLocalVault(values["reset-config"] ? buildBaseEnv() : env, uiDirectory);
  console.log(
    "Local vault initialised. Generated UI configuration and private testing credentials are ready.",
  );
} finally {
  unlinkSync(lockPath);
}
