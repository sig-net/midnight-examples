# Tron Deposit

This adds Tron deposits to the vault. A user sends a TRC-20 from their Tron deposit address to the vault and gets shielded vault tokens on Midnight, the same way an ERC20 deposit from Ethereum works today.

The flow is the same as the [Ethereum deposit](../../deposit/deposit.md) so this doc only covers how Tron deviates from EVM and what happens to requests that never get a response.

## How it deviates from EVM

The request queue, the attestation check, the ownership commitment and the mint are the same code the Ethereum deposit uses. There are 3 differences:

1. Tron transactions have no nonce, they have an expiration
2. Tron has its own token list, last seen height, vault token and key path
3. Tron USDT returns `false` on a successful transfer

### No nonce

Tron accepts a tx if a tx with the same id is not already on chain, the expiration has not passed and the reference block exists on chain. So instead of a nonce and gas params the user passes these when they start the deposit:

```compact
export struct TronTxFields {
  refBlockBytes: Bytes<2>;
  refBlockHash: Bytes<8>;
  timestamp: Uint<64>;
  expiration: Uint<64>;
  feeLimit: Uint<64>;
}
```

`startTronDeposit` stores them and `sendTronDeposit` builds the tx from them. The MPC signs exactly that tx and does not fill in or refresh any field.

Because there is no nonce a request can't become unviable from another tx using the nonce like on Ethereum. On Tron unviable means the expiration passed and the tx never landed. This means every Tron request gets a response by its expiration at the latest. If the transfer failed or the request is unviable we don't mint, and there is nothing to refund because a deposit does not lock any tokens on Midnight.

The vault does not check the expiration against the Midnight block time. The MPC checks it when it picks up the request (it has to be after the source block time and at most 24h after it). We don't need the check in the vault for deposit because no funds are at risk. Withdraw needs it because it burns the user's coin first.

### Separate state for Tron

| What | Ethereum | Tron | Why |
|---|---|---|---|
| Allowed tokens | `allowedTokens` | `allowedTronTokens` | A token allowed on Ethereum should not automatically be allowed on Tron. |
| Last seen height | `globalLastSeen` | `tronLastSeen` | Block heights on the two chains are unrelated so we can't take a max across them. |
| Vault token | `vaultTokenDomainSeparator` | `vaultTronTokenDomainSeparator` | Otherwise a user could deposit USDT on Tron and withdraw USDT on Ethereum. |
| User key path | `userCommitment(sk)` | `tronUserCommitment(sk)` | With the same path anyone can link a user's Tron deposits to their Ethereum deposits. |

The path is public in the request and the MPC derives the user's deposit address from it. For Tron we hash the same secret with a different tag (`"vault:tron:user:"`) so the user gets a different key on Tron and the two deposit addresses can't be linked.

The vault's own Tron account uses the same key as its Ethereum account. The address is `tronAddress(vaultEvmAddress)` which is `0x41` + the same 20 bytes.

### USDT returns false

Tron USDT has `transfer(...) returns (bool)` but it returns `false` on a successful transfer and reverts on a failed one. We set the USDT address in `initialise` as `tronUsdtAddress` and `completeTronDeposit` mints if the attested result is what we expect for that token:

```compact
if (transferred == (args.request.tokenAddress != tronUsdtAddress)) {
  // mint
}
```

So for USDT we mint on `false` and for every other token we mint on `true`. There is no flag to skip the check.

## Requests that never get a response

A deposit request is only removed from the ledger when it completes, and it needs an MPC attestation to complete. So a request the MPC never responds to is never removed.

On Tron this happens if the reference block is older than 24h or does not exist, because the MPC only goes back 24h from the expiration to attest unviable. The vault can't check this properly, it only gets the last 2 bytes of the reference block's height and can't verify its hash. Our flows use the latest block.

This is not new. An Ethereum deposit tx that can't be mined (e.g. a nonce ahead of the account's nonce, or no ETH for gas) also never gets a response, and on both chains a user can start a deposit and never send it.

A deposit does not lock funds, the request just takes up space in the ledger. It will matter less once the MPC can query a request from contract storage instead of reading the full state. Tron requests have an expiration so we can add a circuit to remove them once it has passed. We need the block time check against the expiration (`secondsOfMillis` and `assertTronWithdrawSendClosed`) from the withdraw PR for that, so we can add it once the withdraw PR lands.
