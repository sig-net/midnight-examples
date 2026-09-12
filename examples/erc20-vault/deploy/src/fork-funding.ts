// Vault setup funds the user deposit account, the shared vault and the Aave reserve.
import { AAVE_USDC } from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  type ContractWriteMethod,
  ensureAnvilErc20Balance,
  ensureAnvilEthBalance,
  isAnvil,
  requireEnv,
} from "@sig-net/midnight-examples-lib";
import { ethers } from "ethers";

/** Real Sepolia USDC (the swap suite's tokenIn), also present on a Sepolia fork. */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
// Aave v3 Sepolia PoolConfigurator + a pool admin: the live USDC reserve is supplied ~2x over its
// cap, so maxDeposit is 0 and stataUSDC deposits revert. The fork lifts the cap through these.
const AAVE_POOL_CONFIGURATOR = "0x7Ee60D184C24Ef7AfC1Ec7Be59A0f448A0abd138";
const AAVE_POOL_ADMIN = "0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00";
const ONE_ETH = "0xDE0B6B3A7640000";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/**
 * Apply the vault example's ETH, Circle USDC and Aave USDC funding targets to a recipient.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param to - The recipient address.
 * @param usdc - Circle USDC base units to deal (0 deals none).
 * @param aaveUsdc - Aave USDC base units to deal (0 deals none), the lending suite's underlying.
 */
export async function dealFork(
  provider: ethers.JsonRpcProvider,
  to: string,
  usdc: bigint,
  aaveUsdc = 0n,
): Promise<void> {
  await ensureAnvilEthBalance(provider, to, BigInt(ONE_ETH));
  await ensureAnvilErc20Balance(provider, SEPOLIA_USDC, to, usdc);
  await ensureAnvilErc20Balance(provider, AAVE_USDC, to, aaveUsdc);
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
 * Setup step: deal the derived EVM accounts their gas + tokens on the fork. The user gets ETH +
 * USDC (the deposit source), and the vault gets ETH (withdraw/approve/swap gas, deposits fund
 * its USDC). Dealing is anvil's `anvil_*` cheatcodes, so on any other node (a real chain
 * behind a public RPC) the step skips and prints what to fund by hand instead: the flows'
 * funding preflights then check those balances before spending.
 *
 * @param env - The suite's env accumulator (reads EVM_RPC_URL, EVM_USER_ADDRESS, EVM_VAULT_ADDRESS).
 * @throws {Error} If the RPC does not answer, or the anvil cheatcalls fail on an anvil that is
 *   not forking Sepolia.
 */
export async function dealForkEvmAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const user = requireEnv(env, "EVM_USER_ADDRESS");
  const vault = requireEnv(env, "EVM_VAULT_ADDRESS");

  if (!(await isAnvil(rpcUrl))) {
    console.log(`${rpcUrl} is not anvil: no cheatcodes, so nothing is dealt`);
    console.log(" ➜ FUND THE DERIVED ACCOUNTS ON THE REAL CHAIN before the flows run:");
    console.log(
      `   user  ${user}: >= 0.01 ETH (funding reserve) and >= 0.1 of ERC20 ${requireEnv(env, "ERC20_ADDRESS")}`,
    );
    console.log(
      `   vault ${vault}: ETH for withdrawal gas (the withdraw preflight prints the maximum gas fee)`,
    );
    console.log(
      " ➜ 💡 STEP_THROUGH=1 pauses before every step and test, so an attended run can fund them",
    );
    console.log("   here and continue");
    return;
  }

  // The token must exist before its balance mapping can be probed.
  if ((await provider.getCode(SEPOLIA_USDC)) === "0x") {
    throw new Error(
      `${SEPOLIA_USDC} has no code on ${rpcUrl}: the EVM is not forking Sepolia. Set ` +
        `SEPOLIA_FORK_RPC_URL (in CI, the caller workflow must also pass \`secrets: inherit\`).`,
    );
  }

  // The lending suite deposits Aave's own USDC (the stataUSDC wrapper's asset()), a different
  // token from Circle's USDC. Deal it only when it forks in: the fork-dependency step that runs
  // next fails the whole pipeline on a fork missing the stataUSDC wrapper this is the asset() of,
  // with an error naming the wrapper.
  const aaveUsdcOnFork = (await provider.getCode(AAVE_USDC)) !== "0x";
  const decimals = (await new ethers.Contract(SEPOLIA_USDC, ERC20_ABI, provider).getFunction(
    "decimals",
  )()) as bigint;
  const userUsdc = ethers.parseUnits("100", decimals);
  const aaveDecimals = aaveUsdcOnFork
    ? ((await new ethers.Contract(AAVE_USDC, ERC20_ABI, provider).getFunction(
        "decimals",
      )()) as bigint)
    : undefined;
  const userAaveUsdc = aaveDecimals === undefined ? 0n : ethers.parseUnits("100", aaveDecimals);

  try {
    await dealFork(provider, user, userUsdc, userAaveUsdc);
    await dealFork(provider, vault, 0n);
    if (aaveUsdcOnFork) await liftAaveUsdcSupplyCap(provider);
  } catch (error) {
    throw new Error(
      `fork dealing failed for ${rpcUrl}: the EVM must be a Sepolia fork with anvil_* cheatcodes`,
      { cause: error },
    );
  }
  console.log(
    `dealt on fork: user ${user} <- 100 USDC${aaveUsdcOnFork ? " + 100 Aave USDC" : ""} + gas, ` +
      `vault ${vault} <- gas`,
  );
}
