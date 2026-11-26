// Offline unit test of the Tron lend setup steps over a TRON_ALLOWED_TOKENS the setup did not
// write. No stack, no env gate: the steps return before any Tron call.

import { resolveTronLendPair } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { describe, expect, it } from "vitest";

import { ensureTestErc4626, ensureTronLendDefaults } from "../src/tron-setup.ts";

const TRC20 = `0x${"7a".repeat(20)}`;
const TRON_USDT = `0x${"75".repeat(20)}`;

describe("the Tron lend setup steps", () => {
  it("leave the pair unset when TRON_ALLOWED_TOKENS is set without a share token", async () => {
    const env: NodeJS.ProcessEnv = {
      TRON_RPC_URL: "http://127.0.0.1:9",
      TRON_USDT_ADDRESS: TRON_USDT,
      TRON_ALLOWED_TOKENS: `${TRC20},${TRON_USDT}`,
    };
    await ensureTestErc4626(env);
    ensureTronLendDefaults(env);
    expect(env.TRON_LEND_SHARE_TOKEN).toBeUndefined();
    expect(env.TRON_TOKEN_FACTORS).toBeUndefined();
    expect(resolveTronLendPair(env)).toBeUndefined();
  });
});
