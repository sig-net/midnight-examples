# Take Fees On Vault Operations

This design proposal exists to address a medium severity audit finding.

## The audit finding

Audit finding SNA-01 ("Full Refunds on Failed Swaps Enable Repeatable EVM Gas Drain", severity Medium) describes a griefing attack against the vault's EVM account.

Every vault operation that touches the EVM (withdraw, approve, swap, supply, redeem) is an EVM transaction sent from the vault's address, so the vault pays the gas for it. When the EVM transaction fails, the matching `complete*` circuit re-mints the requester's surrendered input in full, so the requester ends the round trip holding exactly what they started with. The only party losing anything is the vault, which paid the gas for a transaction that failed on the EVM side.

That asymmetry is exploitable because nothing in `startSwap` (or the other `start*` circuits) requires the request to be economically meaningful. An attacker could build a request that is guaranteed to revert on the EVM, and after driving it through its lifecycle use the legitimate MPC attestation of the failure to claim back the assets they surrendered on start, leaving the vault at a loss of gas.

## Proposed Protection Against the Attack

The vault will charge a small, non-refundable fee on every vault operation that costs the vault EVM gas. The fee, configurable by the operator, should be set so that it is a trivial amount to a legitimate user but sized so that it is worth more than the gas the vault burns on that operation. It is taken at the `start*` step and is never returned, whichever way the operation settles: executed, failed or unviable. This change removes the economics of the attack. A reverting request now costs the attacker at least what it costs the vault, so the griefing loop runs at a loss for the attacker on every cycle. Honest users see a negligible charge on each operation, and the vault's EVM account is net funded rather than net drained by traffic.

The fee's denomination, its amount, where it accrues, how it is sized against gas prices, and how it is collected are design questions for the sections that follow.

Each fee is minted straight to a collection address the operator controls, who sells the proceeds to fund the vault's EVM gas.

## Which Operations Pay

Only the operations whose EVM transaction the vault's own account signs and pays: `startWithdraw`, `startSwap`, `startSupply`, `startRedeem`. `startDeposit` is excluded since the depositor's own EVM account signs and pays that transaction. `startApprove*` and `startReplaceNonce` are deployer-gated, so the deployer is only griefing themself.

Every one of the four already takes a surrendered vault coin, so the fee is charged in that same vault token: `erc20AddressIn` for a swap, `erc20Address` for a withdraw, `stataUnderlying` for a supply, `stataToken` for a redeem.

The fee is kept on every verdict, including unviable. Unviable only follows the deployer replacing the request's nonce, so refunding it there is perhaps desirable, but that needs a different architecture, one where the fee is held back and only released to the operator once the request has settled. The implementation should carry a comment saying a refund on unviable verdicts is perhaps wanted but not yet implemented.

## Fee Configuration Stored Per Allowed Token

Each allowed token carries one flat fee per action, in that token's base units, set by the deployer. Gas limits range from 100k for a withdraw to 700k for a swap, so one fee per token would either overcharge withdraws sevenfold or underprice swaps.

### State Update

The contract currently stores allowed assets as a set of ERC20 token addresses:

```compact
export ledger allowedTokens: Set<Bytes<20>>;
```

This becomes a map from token to a struct, keeping the name since the keys are still exactly the allowed tokens. A struct rather than a bare number so an integrator can add fields without changing the map's shape:

```compact
export struct TokenFees {
  withdraw: Uint<64>;
  swap: Uint<64>;
  supply: Uint<64>;
  redeem: Uint<64>;
}

export struct AllowedTokenConfig {
  fees: TokenFees;
}

export ledger allowedTokens: Map<Bytes<20>, AllowedTokenConfig>;
```

`stataToken` is not in the set today but a redeem surrenders it, so `initialise()` gains a `TokenFees` parameter for each of `stataUnderlying` and `stataToken` and inserts both. With that, every vault coin that can exist is a key in the map, so a start circuit looks its fee up directly: the coin colour check already ties the coin to the token, and no further allowed-token check is needed on the surrendered side.

### Configuration Circuits

`addAllowedToken()` takes the fees alongside the address, and a second deployer circuit updates them later without re-adding the token:

```compact
export circuit addAllowedToken(erc20Address: Bytes<20>, fees: TokenFees): [] {
  requireInitialised();
  requireDeployer();
  assert(erc20Address as Field != 0 as Field, "ERC20 address cannot be zero");
  allowedTokens.insert(disclose(erc20Address), disclose(AllowedTokenConfig { fees: fees }));
}

export circuit setTokenFees(erc20Address: Bytes<20>, fees: TokenFees): [] {
  requireInitialised();
  requireDeployer();
  requireTokenAllowed(erc20Address);
  allowedTokens.insert(disclose(erc20Address), disclose(AllowedTokenConfig { fees: fees }));
}
```

A zero fee is allowed and simply disables charging for that action, which keeps the local stack and tests working unchanged where wanted.

### Helper Circuits

The deployer check is repeated verbatim in five circuits today, so it becomes a helper, as does the allowed-token check:

```compact
circuit requireDeployer(): [] {
  assert(userCommitment(callerSecretKey()) == deployer, "Not the deployer");
}

circuit requireTokenAllowed(erc20Address: Bytes<20>): [] {
  assert(allowedTokens.member(disclose(erc20Address)), "ERC20 not allowed");
}

circuit tokenFees(erc20Address: Bytes<20>): TokenFees {
  requireTokenAllowed(erc20Address);
  return allowedTokens.lookup(disclose(erc20Address)).fees;
}
```

## Fee Recipient

Fees are minted directly to a collection address the operator controls. The contract holds no fee state and has no withdrawal circuit: the operator spends fee coins with a normal wallet, exactly like any vault coin.

```compact
// The address every fee is minted to. The encryption key is for clients, which need
// it to attach the ciphertext that lets the recipient's wallet find the coin.
export ledger feeRecipientCoinPublicKey: ZswapCoinPublicKey;
export ledger feeRecipientEncryptionPublicKey: Bytes<32>;
```

Both are set in `initialise()` and changed by a deployer-gated `setFeeRecipient(coinPublicKey, encryptionPublicKey)`.

### What the Collection Address Reveals

The collection address is public, and so is every fee coin minted to it (colour, value and nonce), so anyone can tally the vault's fee income coin by coin. Fee amounts are a public flat rate anyway. What stays hidden is spending: a coin's nullifier is a hash over the coin and the spender's secret key, so nobody can tell when a fee coin is spent or where it went.

The operator therefore treats the collection address as a public mailbox. To move the funds somewhere private they make one ordinary shielded wallet transfer to another address of theirs. That transfer publishes nullifiers nobody can link to the fee coins and an output whose nonce and ciphertext only the operator knows, so after one hop the funds are as private as any shielded balance. Wallet coin selection sweeps as many fee coins as it likes in that one transaction.

> **Note:** the alternative of holding each fee as a contract-owned coin in a ledger map, as [Midnight's private tip jar tutorial](https://docs.midnight.network/tutorials/private-tip-jar/smart-contract) does, was dropped. It keeps the operator's address off the ledger and leaves a refund on unviable feasible, but it needs a pot map, a `withdrawFee` circuit that burns and re-mints under a withdrawer-chosen nonce (a plain `sendShielded` payout derives its nonce from the public pot nonce, which lets a candidate address be tested against the output), a batch variant, and a key-collision check on every start. Its only privacy gain is the address, which the hop above recovers in one transaction.

## Taking the Fee in a Start Circuit

The caller passes one coin worth `amountInMaximum + fee`. The circuit receives it and burns it whole, as today, then mints a new coin worth exactly the fee to the fee recipient. Supply stays balanced: `amountInMaximum + fee` is burnt, `fee` is minted now, and the `complete*` circuit mints at most `amountInMaximum` later, exactly as it does today.

The mint nonce is derived from `inIndex`, which the circuit already discloses, so it is public and unique: the index-in-use check refuses a second request under the same `inIndex`, and the coin's colour already binds it to this contract. A public nonce is what makes every fee coin recomputable from the chain (see Fee Discovery).

```compact
circuit feeMintNonce(inIndex: Uint<64>): Bytes<32> {
  return evolveNonce(inIndex as Uint<128>, pad(32, "erc20:vault:fee"));
}
```

The circuit's signature is unchanged: the caller still passes `inIndex`, the request and one coin. Only the coin's required value changes.

```compact
export circuit startSwap(
  inIndex: Uint<64>,
  swapRequest: SwapRequest,
  coin: ShieldedCoinInfo
): [] {
  requireInitialised();
  // ...the existing request checks...
  const disclosedIndex = disclose(inIndex);
  assert(
    !inputRequestBuffer.member(disclosedIndex) && !swapArgsMap.member(disclosedIndex),
    "Index already in use"
  );

  const fee = tokenFees(swapRequest.erc20AddressIn).swap;
  assert(
    coin.value == swapRequest.amountInMaximum + fee,
    "Coin value must equal amountInMaximum plus fee"
  );
  receiveShielded(disclose(coin));
  sendImmediateShielded(disclose(coin), shieldedBurnAddress(), disclose(coin).value);
  if (fee > 0 as Uint<64>) {
    mintShieldedToken(
      vaultTokenDomainSeparator(swapRequest.erc20AddressIn),
      fee,
      feeMintNonce(disclosedIndex),
      left<ZswapCoinPublicKey, ContractAddress>(feeRecipientCoinPublicKey)
    );
  }

  // ...queue the request exactly as today, with `fee` recorded in SwapArgs...
}
```

The fee charged is recorded in the request's args struct (`SwapArgs` and its siblings gain a `fee` field) so the fee coin can be recomputed later. The complete circuits are untouched: a failure still re-mints `amountInMaximum`, never the fee.

### How the Coins Flow

Three coins exist by the end of a start, and every one has a different nonce. The burn output's nonce is derived by the standard library from the input nonce with a fixed domain separator, and the fee coin's nonce is derived by the circuit from the public `inIndex`, so no two coins in the flow can collide.

```text
caller's wallet                       contract                              burn address
───────────────                       ────────                              ────────────

{ color, nonce0, amountInMaximum + fee }
        │
        │  receiveShielded: the wallet pays for this coin as a Zswap output
        │  addressed to the contract. nonce0 is fresh, drawn by the client.
        ▼
                              { color, nonce0, amountInMaximum + fee }
                                              │
                                              │  sendImmediateShielded(coin, burn, coin.value)
                                              │  spends nonce0 (publishes its nullifier)
                                              │  and creates the burn output:
                                              │
                                              └──────────────────────────────────────────┐
                                                                                         ▼
                                                                { color, nonce1, amountInMaximum + fee }
                                                                nonce1 = evolve("…nonce_evolve", nonce0)
                                                                owner: the burn address, gone for good

                              mintShieldedToken(domainSep, fee, nonceF, feeRecipient)
                                              │
                                              ▼
                              { color, nonceF, fee }                       ──▶  collection address
                              nonceF = evolveNonce(inIndex, "erc20:vault:fee")
```

## Fee Discovery by the Operator

A shielded output on Midnight is only a commitment and a nullifier: nothing on the chain names the recipient. A wallet discovers a coin sent to it by scanning every output for a ciphertext it can decrypt. That ciphertext is the coin's details encrypted to the recipient's encryption public key, a separate key from the coin public key the circuit's recipient carries. The circuit therefore knows where to commit the coin but cannot encrypt it, and the ciphertext has to be attached by the client building the transaction.

Midnight.js attaches it from a resolver mapping coin public keys to encryption keys. It knows the caller's own wallet and the burn address, and a third party only when given the mapping explicitly (`additionalCoinEncPublicKeyMappings` on the call). An honest client reads `feeRecipientEncryptionPublicKey` from the ledger and passes that mapping, and the fee shows up in the collection wallet at once.

Discovery is a wallet concern, not a contract one, so the contract does nothing more. For clients that omit the mapping, every fee coin is recomputable from public data: colour from the token, value from the `fee` recorded in the request's args, nonce from `feeMintNonce(inIndex)`. A small operator tool walks the args maps, rebuilds each fee coin, and registers any the wallet has not seen with `watchFor`, which lets the wallet notice a commitment without a ciphertext.

## Residual Risk

This does not fully close SNA-01, and the answer to the auditor should say so. The fee is a fixed token amount set by hand, so it drifts against the token's price, ETH's price and every `setGasParams` change, and the protection is only as strong as the cheapest fee across all allowed tokens and actions, since an attacker picks that one. When a fee has drifted low the vault can still pay more gas than it collects.

What the fee does guarantee is that every attempt costs the attacker real value for no gain, where today it costs nothing. The operator's duty is to set each fee with a margin above the action's worst-case gas at the current prices, and to revisit the fees whenever gas parameters or prices move. In practice that is a scheduled off-chain job that reprices every fee from current gas and token prices and calls `setTokenFees` when one has drifted.
