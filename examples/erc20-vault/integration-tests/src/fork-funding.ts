// Fork-only EVM funding: deal ETH + real USDC to the derived accounts. Every suite runs against
// a Sepolia fork where the ERC20 is the real, unmintable USDC. USDC is sourced by impersonating
// a pool that holds a large balance (anvil cheatcodes), the same trick swap-e2e uses inline.
import { type ContractWriteMethod, requireEnv } from "@midnight-examples/test-harness";
import { ethers } from "ethers";

/** Real Sepolia USDC (the swap suite's tokenIn), also present on a Sepolia fork. */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const USDC_WHALE = "0x68adf381b8f9e9e100bb6e13d50b14094e3b6a9d"; // USDC/EURC pool, holds USDC on the fork
const ONE_ETH = "0xDE0B6B3A7640000";
// 100 USDC (6 decimals): far above every suite's small deposits combined, and safely under the
// USDC/EURC pool's live balance (~hundreds of USDC) so the impersonated transfer never reverts.
const USER_USDC = 100_000_000n;

const ERC20_ABI = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * Deal ETH (+ optional USDC) to `to` on the fork: anvil setBalance + an impersonated whale transfer.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param to - The recipient address.
 * @param usdc - USDC base units to deal (0 deals only ETH).
 */
export async function dealFork(
  provider: ethers.JsonRpcProvider,
  to: string,
  usdc: bigint,
): Promise<void> {
  await provider.send("anvil_setBalance", [to, ONE_ETH]);
  if (usdc > 0n) {
    await provider.send("anvil_setBalance", [USDC_WHALE, ONE_ETH]);
    await provider.send("anvil_impersonateAccount", [USDC_WHALE]);
    const token = new ethers.Contract(
      SEPOLIA_USDC,
      ERC20_ABI,
      await provider.getSigner(USDC_WHALE),
    );
    await (await token.getFunction<ContractWriteMethod>("transfer")(to, usdc)).wait();
    await provider.send("anvil_stopImpersonatingAccount", [USDC_WHALE]);
  }
}

/**
 * Setup step: deal the derived EVM accounts their gas + tokens on the fork. The user gets ETH +
 * USDC (the deposit source), and the vault gets ETH (withdraw/approve/swap gas, deposits fund
 * its USDC). Requires EVM_RPC_URL to point at a Sepolia fork exposing anvil_* cheatcodes.
 *
 * @param env - The suite's env accumulator (reads EVM_RPC_URL, EVM_USER_ADDRESS, EVM_VAULT_ADDRESS).
 * @throws {Error} If the anvil cheatcalls fail (the EVM is not a cheatcode-capable fork).
 */
export async function dealForkEvmAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const user = requireEnv(env, "EVM_USER_ADDRESS");
  const vault = requireEnv(env, "EVM_VAULT_ADDRESS");

  // Fail loudly BEFORE dealing: a tx to a code-less address does not revert, so on a bare
  // (non-forking) anvil dealFork's USDC transfer silently no-ops and the failure surfaces
  // 15 minutes later as an opaque decimals() error. If USDC has no code, the EVM is not
  // forking Sepolia, almost always a missing/empty SEPOLIA_FORK_RPC_URL.
  if ((await provider.getCode(SEPOLIA_USDC)) === "0x") {
    throw new Error(
      `${SEPOLIA_USDC} has no code on ${rpcUrl}: the EVM is not forking Sepolia. Set ` +
        `SEPOLIA_FORK_RPC_URL (in CI, the caller workflow must also pass \`secrets: inherit\`).`,
    );
  }

  try {
    await dealFork(provider, user, USER_USDC);
    await dealFork(provider, vault, 0n);
  } catch (error) {
    throw new Error(
      `fork dealing failed for ${rpcUrl}: the EVM must be a Sepolia fork with anvil_* cheatcodes`,
      { cause: error },
    );
  }
  console.log(`dealt on fork: user ${user} <- 100 USDC + gas; vault ${vault} <- gas`);
}
