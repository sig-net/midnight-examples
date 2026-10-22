# Take Fees On Vault Operations

This design proposal exists to address a medium severity audit finding.

## The audit finding

Audit finding SNA-01 ("Full Refunds on Failed Swaps Enable Repeatable EVM Gas Drain", severity Medium) describes a griefing attack against the vault's EVM account.

Every vault operation that touches the EVM (withdraw, approve, swap, supply, redeem) is an EVM transaction sent from the vault's address, so the vault pays the gas for it. When the EVM transaction fails, the matching `complete*` circuit re-mints the requester's surrendered input in full, so the requester ends the round trip holding exactly what they started with. The only party losing anything is the vault, which paid the gas for a transaction that failed on the EVM side.

That asymmetry is exploitable because nothing in `startSwap` (or the other `start*` circuits) requires the request to be economically meaningful. An attacker could build a request that is guaranteed to revert on the EVM, and after driving it through its lifecycle use the legitimate MPC attestation of the failure to claim back the assets they surrendered on start, leaving the vault at a loss of gas.

## Proposed Protection Against the Attack

The vault will charge a small, non-refundable fee on every vault operation that costs the vault EVM gas. The fee, configurable by the operator, should be set so that it is a trivial amount to a legitimate user but sized so that it is worth more than the gas the vault burns on that operation. It is taken at the `start*` step and is never returned, whichever way the operation settles: executed, failed or unviable. This change removes the economics of the attack. A reverting request now costs the attacker at least what it costs the vault, so the griefing loop runs at a loss for the attacker on every cycle. Honest users see a negligible charge on each operation, and the vault's EVM account is net funded rather than net drained by traffic.

The fee's denomination, its amount, where it accrues, how it is sized against gas prices, and how it is collected are design questions for the sections that follow.

The vault operator will be allowed to withdraw these fees to eventually withdraw and sell to pay for gas for the vault.

## Fee Configuration Stored Per Allowed Token

Each allowed token will have a flat fee stored alongside it.

### State Update

The contract currently stores allowed assets as a set of ERC20 token addresses:

```compact
export ledger allowedTokens: Set<Bytes<20>>;
```

This will be extended to store a flat fee alongside each allowed token:

```compact
export ledger allowedTokenMap: Map<Bytes<20>, Uint<64>>;
```

### Configuration Circuits

The Update `addAllowedToken()` function extended to add fee:

```compact
export circuit addAllowedToken(erc20Address: Bytes<20>, flatFee: Uint<64>): [] {
  requireInitialised();
  requireCaller(); // see new helper circuit added
  allowedTokens.insert(disclose(erc20Address), );
}
```

and a method to configure the fee

### Helper circuits added.

Some new helper circuits.

## New Allowed Token Helpers

First a helper circuit to replace duplication of the "allowed tokens" check across the contract
```compact
// helper circuit to be used wherever an asset is checked for allowednesss...
export circuit requireTokenAllowed(tokenAddress: Bytes<20>) [] {
  assert(allowedTokens.member(disclose(tokenAddress)), "ERC20 not allowed");
}
```

Then a helper to get the fee:
```compact
export circuit getTokenFee(tokenAddress: Bytes<20>): Uint<64> {
  requireTokenAllowed(tokenAddress);
  return allowedTokens.value(tokenAddress);
}
```

## Shielded Token Registry to store fee token taken

## Operator withdrawal
Transfer from contract token registry to a recipient `Maybe<Either<ZswapCoinPublicKey, ContractAddress>>`

## Example Usage in the Start Swap Method

Use at the start of the swap to literally just take the fee coin and give it to the contract, storing in the registry.
