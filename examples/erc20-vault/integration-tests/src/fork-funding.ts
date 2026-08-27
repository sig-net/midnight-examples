// Fork-only EVM funding: deal ETH + real USDC to the derived accounts. Every suite runs against
// a Sepolia fork where the ERC20 is the real, unmintable USDC. Token balances are dealt by
// writing the holder's slot in the token's balance mapping directly (anvil_setStorageAt, the
// same mechanism as foundry's `deal`), so dealing needs no funded source account and repeated
// redeploy campaigns can never exhaust one.
import { type ContractWriteMethod, requireEnv } from "@midnight-examples/test-harness";
import { ethers } from "ethers";

/** Real Sepolia USDC (the swap suite's tokenIn), also present on a Sepolia fork. */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** Aave v3 Sepolia USDC (the lending suite's underlying), the stataUSDC wrapper's `asset()`. */
export const AAVE_USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
// Aave v3 Sepolia PoolConfigurator + a pool admin: the live USDC reserve is supplied ~2x over its
// cap, so maxDeposit is 0 and stataUSDC deposits revert. The fork lifts the cap through these.
const AAVE_POOL_CONFIGURATOR = "0x7Ee60D184C24Ef7AfC1Ec7Be59A0f448A0abd138";
const AAVE_POOL_ADMIN = "0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00";
const ONE_ETH = "0xDE0B6B3A7640000";
// 100 USDC (6 decimals): far above every suite's small deposits combined.
const USER_USDC = 100_000_000n;

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const readBalance = (
  provider: ethers.JsonRpcProvider,
  token: string,
  holder: string,
): Promise<bigint> =>
  new ethers.Contract(token, ERC20_ABI, provider).getFunction("balanceOf")(
    holder,
  ) as Promise<bigint>;

/**
 * Find the storage location of `holder`'s entry in `token`'s balance mapping by probing: for
 * each candidate mapping slot, write a sentinel to the location that slot implies, check whether
 * `balanceOf(holder)` reads it back, and restore the original word either way. Tries the
 * Solidity mapping layout (`keccak256(holder ++ slot)`) and the Vyper layout
 * (`keccak256(slot ++ holder)`) for each slot. Works through proxies, since the probe targets
 * the address `balanceOf` is called on — where a proxy keeps its storage.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param token - The ERC20 token contract.
 * @param holder - The account whose balance location is sought.
 * @returns The 32-byte storage location of the holder's balance.
 * @throws {Error} If no slot in 0..63 maps to `balanceOf` (a non-standard balance layout).
 */
async function findBalanceLocation(
  provider: ethers.JsonRpcProvider,
  token: string,
  holder: string,
): Promise<string> {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const current = await readBalance(provider, token, holder);
  const sentinel = current === 1_337_733_113_377_331n ? current + 1n : 1_337_733_113_377_331n;
  const sentinelWord = ethers.toBeHex(sentinel, 32);

  for (let slot = 0; slot < 64; slot++) {
    const candidates = [
      ethers.keccak256(abi.encode(["address", "uint256"], [holder, slot])),
      ethers.keccak256(abi.encode(["uint256", "address"], [slot, holder])),
    ];
    for (const location of candidates) {
      const original = await provider.getStorage(token, location);
      await provider.send("anvil_setStorageAt", [token, location, sentinelWord]);
      const observed = await readBalance(provider, token, holder);
      await provider.send("anvil_setStorageAt", [token, location, original]);
      if (observed === sentinel) return location;
    }
  }
  throw new Error(
    `no balance mapping slot found for ${token} in slots 0..63: the token has a non-standard ` +
      `balance layout, so it cannot be dealt by storage write`,
  );
}

/**
 * Set `to`'s balance of `token` to `amount` on the fork by writing the balance mapping slot
 * directly. Total supply is left untouched, exactly like foundry's `deal` — irrelevant on a
 * throwaway fork. Setting (rather than transferring) makes dealing idempotent across setup
 * reruns and independent of any source account's balance.
 *
 * @param provider - The fork's JSON-RPC provider (anvil with cheatcodes).
 * @param token - The ERC20 token contract.
 * @param to - The account whose balance is set.
 * @param amount - The base-unit balance to set.
 * @throws {Error} If the balance read back after the write does not equal `amount`.
 */
async function dealErc20(
  provider: ethers.JsonRpcProvider,
  token: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const location = await findBalanceLocation(provider, token, to);
  await provider.send("anvil_setStorageAt", [token, location, ethers.toBeHex(amount, 32)]);
  const observed = await readBalance(provider, token, to);
  if (observed !== amount) {
    throw new Error(
      `dealt ${String(amount)} of ${token} to ${to} but balanceOf reads ${String(observed)}`,
    );
  }
}

/**
 * Deal ETH (+ optional USDC / Aave USDC) to `to` on the fork: anvil setBalance + balance-slot
 * writes. Token amounts SET the balance (idempotent), never add to it.
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
  if (usdc > 0n) await dealErc20(provider, SEPOLIA_USDC, to, usdc);
  if (aaveUsdc > 0n) await dealErc20(provider, AAVE_USDC, to, aaveUsdc);
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
 * @param env - The suite's env accumulator (reads EVM_RPC_URL, EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS,
 *   EVM_VAULT_ACCOUNT_ADDRESS, EVM_USER1_WALLET_ACCOUNT_ADDRESS).
 * @throws {Error} If the anvil cheatcalls fail (the EVM is not a cheatcode-capable fork).
 */
export async function dealForkEvmAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const user = requireEnv(env, "EVM_USER1_DEPOSIT_ACCOUNT_ADDRESS");
  const vault = requireEnv(env, "EVM_VAULT_ACCOUNT_ADDRESS");
  const userWallet = requireEnv(env, "EVM_USER1_WALLET_ACCOUNT_ADDRESS");

  // Fail loudly BEFORE dealing: if USDC has no code, the EVM is not forking Sepolia (almost
  // always a missing/empty SEPOLIA_FORK_RPC_URL), and the balance-slot probe would fail with an
  // opaque decode error instead of this pointed one.
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
