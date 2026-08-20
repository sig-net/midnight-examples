// Fork-only EVM funding: deal ETH + real USDC to the derived accounts. Every suite runs against
// a Sepolia fork where the ERC20 is the real, unmintable USDC. USDC is sourced by impersonating
// a pool that holds a large balance (anvil cheatcodes), the same trick swap-e2e uses inline.
import { type ContractWriteMethod, requireEnv } from "@midnight-examples/test-harness";
import { ethers } from "ethers";

/** Real Sepolia USDC (the swap suite's tokenIn), also present on a Sepolia fork. */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const USDC_WHALE = "0x68adf381b8f9e9e100bb6e13d50b14094e3b6a9d"; // USDC/EURC pool, holds USDC on the fork

/** Aave v3 Sepolia USDC (the lending suite's underlying), the stataUSDC wrapper's `asset()`. */
export const AAVE_USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
// Aave's aEthUSDC aToken custodies the reserve's underlying USDC (~tens of thousands on the fork),
// so it is the whale for dealing Aave USDC — the lending counterpart of USDC_WHALE.
const AAVE_USDC_WHALE = "0x16dA4541aD1807f4443d92D26044C1147406EB80";
// Aave v3 Sepolia PoolConfigurator + a pool admin: the live USDC reserve is supplied ~2x over its
// cap, so maxDeposit is 0 and stataUSDC deposits revert. The fork lifts the cap through these.
const AAVE_POOL_CONFIGURATOR = "0x7Ee60D184C24Ef7AfC1Ec7Be59A0f448A0abd138";
const AAVE_POOL_ADMIN = "0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00";
const ONE_ETH = "0xDE0B6B3A7640000";
// 100 USDC (6 decimals): far above every suite's small deposits combined, and safely under each
// whale's live balance so the impersonated transfer never reverts.
const USER_USDC = 100_000_000n;

const ERC20_ABI = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * Transfer `amount` of `token` from an impersonated `whale` to `to` on the fork.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param token - The ERC20 token contract to transfer.
 * @param whale - The account to impersonate (holds `token` on the fork).
 * @param to - The recipient address.
 * @param amount - Base units to transfer.
 */
async function whaleTransfer(
  provider: ethers.JsonRpcProvider,
  token: string,
  whale: string,
  to: string,
  amount: bigint,
): Promise<void> {
  await provider.send("anvil_setBalance", [whale, ONE_ETH]);
  await provider.send("anvil_impersonateAccount", [whale]);
  const contract = new ethers.Contract(token, ERC20_ABI, await provider.getSigner(whale));
  await (await contract.getFunction<ContractWriteMethod>("transfer")(to, amount)).wait();
  await provider.send("anvil_stopImpersonatingAccount", [whale]);
}

/**
 * Deal ETH (+ optional USDC / Aave USDC) to `to` on the fork: anvil setBalance + impersonated
 * whale transfers.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param to - The recipient address.
 * @param usdc - Circle USDC base units to deal (0 deals none).
 * @param aaveUsdc - Aave USDC base units to deal (0 deals none); the lending suite's underlying.
 */
export async function dealFork(
  provider: ethers.JsonRpcProvider,
  to: string,
  usdc: bigint,
  aaveUsdc = 0n,
): Promise<void> {
  await provider.send("anvil_setBalance", [to, ONE_ETH]);
  if (usdc > 0n) await whaleTransfer(provider, SEPOLIA_USDC, USDC_WHALE, to, usdc);
  if (aaveUsdc > 0n) await whaleTransfer(provider, AAVE_USDC, AAVE_USDC_WHALE, to, aaveUsdc);
}

/**
 * Lift the Aave USDC supply cap on the fork so stataUSDC deposits are accepted. The live Sepolia
 * reserve is supplied ~2x over its 2B cap, so Aave's maxDeposit is 0 and every deposit reverts.
 * Impersonate a pool admin and set the cap to 0, which Aave treats as no cap.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 */
async function liftAaveUsdcSupplyCap(provider: ethers.JsonRpcProvider): Promise<void> {
  await provider.send("anvil_setBalance", [AAVE_POOL_ADMIN, ONE_ETH]);
  await provider.send("anvil_impersonateAccount", [AAVE_POOL_ADMIN]);
  const configurator = new ethers.Contract(
    AAVE_POOL_CONFIGURATOR,
    ["function setSupplyCap(address asset, uint256 newSupplyCap)"],
    await provider.getSigner(AAVE_POOL_ADMIN),
  );
  await (await configurator.getFunction<ContractWriteMethod>("setSupplyCap")(AAVE_USDC, 0n)).wait();
  await provider.send("anvil_stopImpersonatingAccount", [AAVE_POOL_ADMIN]);
  console.log("lifted Aave USDC supply cap on the fork (stataUSDC deposits now accepted)");
}

/**
 * Setup step: deal the example's EVM accounts their gas + tokens on the fork. The deposit
 * account gets ETH + USDC (the deposit source), the vault gets ETH (withdraw/approve/swap gas,
 * deposits fund its USDC), and user 1's own wallet account gets ETH + USDC (a spendable wallet
 * on the EVM side). Requires EVM_RPC_URL to point at a Sepolia fork exposing anvil_* cheatcodes.
 *
 * @param env - The suite's env accumulator (reads EVM_RPC_URL, EVM_USER1_DEPOSIT_ADDRESS,
 *   EVM_VAULT_ACCOUNT_ADDRESS, EVM_USER1_WALLET_ADDRESS).
 * @throws {Error} If the anvil cheatcalls fail (the EVM is not a cheatcode-capable fork).
 */
export async function dealForkEvmAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const user = requireEnv(env, "EVM_USER1_DEPOSIT_ADDRESS");
  const vault = requireEnv(env, "EVM_VAULT_ACCOUNT_ADDRESS");
  const userWallet = requireEnv(env, "EVM_USER1_WALLET_ADDRESS");

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

  // The lending suite deposits Aave's own USDC (the stataUSDC wrapper's asset()), a different
  // token from Circle's USDC. Deal it only when it forks in; on a fork missing it, the lending
  // e2e self-skips (stataAvailable), so a hard failure here would be too strict.
  const aaveUsdcOnFork = (await provider.getCode(AAVE_USDC)) !== "0x";
  const userAaveUsdc = aaveUsdcOnFork ? USER_USDC : 0n;

  try {
    await dealFork(provider, user, USER_USDC, userAaveUsdc);
    await dealFork(provider, vault, 0n);
    await dealFork(provider, userWallet, USER_USDC);
    if (aaveUsdcOnFork) await liftAaveUsdcSupplyCap(provider);
  } catch (error) {
    throw new Error(
      `fork dealing failed for ${rpcUrl}: the EVM must be a Sepolia fork with anvil_* cheatcodes`,
      { cause: error },
    );
  }
  console.log(
    `dealt on fork: user ${user} <- 100 USDC${aaveUsdcOnFork ? " + 100 Aave USDC" : ""} + gas; ` +
      `vault ${vault} <- gas; user wallet ${userWallet} <- 100 USDC + gas`,
  );
}
