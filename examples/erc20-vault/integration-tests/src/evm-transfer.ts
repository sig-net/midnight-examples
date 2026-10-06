// EVM value helpers shared by the vault flows.

// EIP-1559 gas parameters for the deposit sweep the MPC signs: the envelope the
// deposit flow chooses at startDeposit, which the caller's derived account pays.
// An ERC20 transfer costs ~50-65k gas, and the fee caps are generous.

/**
 * The ERC20 `transfer(address,uint256)` selector, as broadcast (big-endian).
 * Application-level (this example's vault moves ERC20s) — the in-circuit twin
 * is the literal `Bytes [0xa9, 0x05, 0x9c, 0xbb]` in erc20-vault.compact.
 */
export const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

/**
 * The ERC20 `approve(address,uint256)` selector, as broadcast (big-endian): the
 * TS mirror of the literal `Bytes [0x09, 0x5e, 0xa7, 0xb3]` in the vault's
 * `sendApprove`, which both approvals (router and stata) share.
 */
export const ERC20_APPROVE_SELECTOR = new Uint8Array([0x09, 0x5e, 0xa7, 0xb3]);

/** Gas ceiling of an MPC-signed ERC20 transfer. */
export const ERC20_TRANSFER_GAS_LIMIT = 100_000n;

/** Max total fee per gas of an MPC-signed ERC20 transfer, wei (30 gwei). */
export const ERC20_TRANSFER_MAX_FEE_PER_GAS = 30_000_000_000n;

/** Max priority fee per gas of an MPC-signed ERC20 transfer, wei (1 gwei). */
export const ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
