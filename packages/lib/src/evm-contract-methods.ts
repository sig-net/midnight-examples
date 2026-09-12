import type { ContractMethod, ContractTransactionResponse } from "ethers";

/**
 * A read-only ABI method reached through ethers' `getFunction` accessor.
 *
 * A `Contract` exposes its ABI methods through a string index signature, which
 * `noUncheckedIndexedAccess` types as possibly-undefined, so `erc20.balanceOf(…)`
 * cannot be invoked directly. `getFunction` is ethers' own typed accessor for
 * that call. Its generic pins argument tuples to a loose list, so the precision
 * worth expressing here is the return type.
 */
export type ContractReadMethod<R> = ContractMethod<unknown[], R, R>;

/**
 * A state-changing ABI method reached through ethers' `getFunction` accessor,
 * resolving to the sent transaction. See {@link ContractReadMethod} for why
 * `getFunction` stands in for a direct method access.
 */
export type ContractWriteMethod = ContractMethod<
  unknown[],
  ContractTransactionResponse,
  ContractTransactionResponse
>;
