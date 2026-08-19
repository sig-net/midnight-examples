// FAKENET-ONLY failure-injection support: sign a transaction from the
// vault's derived EVM account with a locally re-derived private key. A real
// MPC never exposes its root key, so this can never be a flow capability —
// it stays in test-support code.

import {
  type ContractReadMethod,
  type ContractWriteMethod,
  requireEnv,
} from "@midnight-examples/test-harness";
import { deriveEpsilon, SECP256K1_ORDER, stripHexPrefix } from "@sig-net/midnight";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

import { VAULT_PATH_HEX } from "./mpc-routing.ts";

const ERC20_TRANSFER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

/**
 * Drain the vault's derived EVM account of its FULL `EVM_ERC20_CONTRACT_ADDRESS` balance,
 * transferring it to `to` and waiting for one confirmation. Fakenet ONLY: it
 * re-derives the vault account's private key from `MPC_ROOT_PRIVATE_KEY` (epsilon
 * path {@link VAULT_PATH_HEX}, the private-key twin of signet-midnight's
 * `deriveEvmAddress`) and refuses to sign unless the derived address matches
 * `EVM_VAULT_ACCOUNT_ADDRESS`.
 *
 * This exists to force a DETERMINISTIC withdraw failure: with the vault's
 * ERC20 balance at zero, the next MPC-signed `transfer` from it must mine
 * and revert. The drain also consumes one vault-account nonce, so fetch the
 * withdraw request's `evmNonce` only AFTER this resolves.
 *
 * @param env - The setup-populated env accumulator (`MPC_ROOT_PRIVATE_KEY`,
 *   `EVM_RPC_URL`, `EVM_ERC20_CONTRACT_ADDRESS`, `MIDNIGHT_VAULT_CONTRACT_ADDRESS`,
 *   `EVM_VAULT_ACCOUNT_ADDRESS`).
 * @param to - Recipient of the drained ERC20 (the suite sends it back to
 *   `EVM_USER1_DEPOSIT_ADDRESS` so the funds keep cycling).
 * @returns The drained amount in ERC20 base units — `0n` when the account
 *   held nothing and no transaction was sent.
 * @throws {Error} If the derived address does not match `EVM_VAULT_ACCOUNT_ADDRESS` (wrong
 *   root key or vault contract address), or the transfer fails to mine.
 */
export async function drainVaultErc20(env: NodeJS.ProcessEnv, to: string): Promise<bigint> {
  const vaultContractAddress = requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const expectedAddress = requireEnv(env, "EVM_VAULT_ACCOUNT_ADDRESS");
  const erc20Address = requireEnv(env, "EVM_ERC20_CONTRACT_ADDRESS");

  // The private-key side of the sig-net v2.0.0 epsilon scheme:
  // epsilon = deriveEpsilon(contract, path) (keccak of the colon-separated
  // "<prefix>:<chainId>:<contract>:<path>" derivation string reduced mod the
  // curve order), derivedPriv = rootPriv + epsilon mod n. deriveEpsilon
  // takes the requester verbatim, so render the address the way
  // deriveEvmAddress does (lowercase, no 0x prefix).
  const epsilon = deriveEpsilon(stripHexPrefix(vaultContractAddress).toLowerCase(), VAULT_PATH_HEX);
  const rootKey = BigInt(requireEnv(env, "MPC_ROOT_PRIVATE_KEY"));
  const derivedPriv = (rootKey + epsilon) % SECP256K1_ORDER;

  const provider = new JsonRpcProvider(requireEnv(env, "EVM_RPC_URL"));
  try {
    const wallet = new Wallet(`0x${derivedPriv.toString(16).padStart(64, "0")}`, provider);
    if (wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `derived ${wallet.address} for the vault account but EVM_VAULT_ACCOUNT_ADDRESS says ${expectedAddress} — ` +
          `refusing to sign anything (stale MPC_ROOT_PRIVATE_KEY or MIDNIGHT_VAULT_CONTRACT_ADDRESS?)`,
      );
    }

    const erc20 = new Contract(erc20Address, ERC20_TRANSFER_ABI, wallet);
    const balance = await erc20.getFunction<ContractReadMethod<bigint>>("balanceOf")(
      wallet.address,
    );
    if (balance === 0n) {
      return 0n;
    }

    console.log(
      `draining ${String(balance)} base units of ${erc20Address} from ${wallet.address} to ${to}`,
    );
    const transfer = erc20.getFunction<ContractWriteMethod>("transfer");
    const tx = await transfer(to, balance);
    console.log(`drain tx:  ${tx.hash} — waiting for 1 confirmation…`);
    await tx.wait(1);
    console.log(`drained:   ${tx.hash}`);
    return balance;
  } finally {
    provider.destroy();
  }
}
