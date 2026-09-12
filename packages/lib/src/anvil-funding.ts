import { ethers } from "ethers";

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
 * the address `balanceOf` is called on, which is where a proxy keeps its storage.
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
      try {
        const observed = await readBalance(provider, token, holder);
        if (observed === sentinel) return location;
      } finally {
        await provider.send("anvil_setStorageAt", [token, location, original]);
      }
    }
  }
  throw new Error(
    `no balance mapping slot found for ${token} in slots 0..63: the token has a non-standard ` +
      `balance layout, so it cannot be dealt by storage write`,
  );
}

/**
 * Set `to`'s balance of `token` to `amount` on the fork by writing the balance mapping slot
 * directly. Total supply is left untouched, exactly like foundry's `deal`, which is irrelevant
 * on a throwaway fork. Setting the balance outright makes dealing idempotent across setup
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
 * Fund an Anvil account up to a native balance target without reducing an existing balance.
 *
 * @param provider - Anvil provider whose ownership the caller has verified.
 * @param recipient - Account receiving the balance.
 * @param target - Minimum balance in wei.
 */
export async function ensureAnvilEthBalance(
  provider: ethers.JsonRpcProvider,
  recipient: string,
  target: bigint,
): Promise<void> {
  if ((await provider.getBalance(recipient)) < target)
    await provider.send("anvil_setBalance", [recipient, ethers.toBeHex(target)]);
}

/**
 * Fund an ERC20 balance up to a target through Anvil storage writes.
 *
 * @param provider - Anvil provider whose ownership the caller has verified.
 * @param token - Token whose balance mapping is probed.
 * @param recipient - Account receiving the balance.
 * @param target - Minimum balance in token base units.
 * @throws {Error} When the token layout cannot be probed or the written balance differs.
 */
export async function ensureAnvilErc20Balance(
  provider: ethers.JsonRpcProvider,
  token: string,
  recipient: string,
  target: bigint,
): Promise<void> {
  if (target > 0n && (await readBalance(provider, token, recipient)) < target)
    await dealErc20(provider, token, recipient, target);
}
