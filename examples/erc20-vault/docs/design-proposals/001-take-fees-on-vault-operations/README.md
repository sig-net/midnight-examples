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

## Which Operations Pay

Only the operations whose EVM transaction the vault's own account signs and pays: `startWithdraw`, `startSwap`, `startSupply`, `startRedeem`. `startDeposit` is excluded since the depositor's own EVM account signs and pays that transaction. `startApprove*` and `startReplaceNonce` are deployer-gated, so the deployer is only griefing themself.

Every one of the four already takes a surrendered vault coin, so the fee is charged in that same vault token: `erc20AddressIn` for a swap, `erc20Address` for a withdraw, `stataUnderlying` for a supply, `stataToken` for a redeem. The user pays one coin of one colour and never needs a second token to transact.

## Fee Configuration Stored Per Allowed Token

Each allowed token carries a flat fee in that token's base units, set by the deployer.

### State Update

The contract currently stores allowed assets as a set of ERC20 token addresses:

```compact
export ledger allowedTokens: Set<Bytes<20>>;
```

This becomes a map from token to its flat fee, keeping the name since the keys are still exactly the allowed tokens:

```compact
export ledger allowedTokens: Map<Bytes<20>, Uint<64>>;
```

Two consequences. `startSwap` currently checks only `erc20AddressOut` against the set, so charging a fee in `erc20AddressIn` requires that token to be allowed too, which is a tightening the audit also asks for. `stataToken` is not in the set today but a redeem surrenders it, so `initialise()` gains a fee parameter for each of `stataUnderlying` and `stataToken` and inserts both. That makes `stataToken` depositable and swappable-to, which is harmless: it is an ERC20 the vault already custodies.

### Configuration Circuits

`addAllowedToken()` takes the fee alongside the address, and a second deployer circuit updates it later without re-adding the token:

```compact
export circuit addAllowedToken(erc20Address: Bytes<20>, flatFee: Uint<64>): [] {
  requireInitialised();
  requireDeployer();
  assert(erc20Address as Field != 0 as Field, "ERC20 address cannot be zero");
  allowedTokens.insert(disclose(erc20Address), disclose(flatFee));
}

export circuit setTokenFee(erc20Address: Bytes<20>, flatFee: Uint<64>): [] {
  requireInitialised();
  requireDeployer();
  requireTokenAllowed(erc20Address);
  allowedTokens.insert(disclose(erc20Address), disclose(flatFee));
}
```

A zero fee is allowed and simply disables charging for that token, which keeps the local stack and tests working unchanged where wanted.

### Helper Circuits

The deployer check is repeated verbatim in five circuits today, so it becomes a helper, as does the allowed-token check:

```compact
circuit requireDeployer(): [] {
  assert(userCommitment(callerSecretKey()) == deployer, "Not the deployer");
}

circuit requireTokenAllowed(erc20Address: Bytes<20>): [] {
  assert(allowedTokens.member(disclose(erc20Address)), "ERC20 not allowed");
}

circuit tokenFee(erc20Address: Bytes<20>): Uint<64> {
  requireTokenAllowed(erc20Address);
  return allowedTokens.lookup(disclose(erc20Address));
}
```

## Fee Pot: Where Collected Fees Live

Midnight has no account balance for shielded value a contract holds. A contract keeps a coin by recording the whole coin, as a `QualifiedShieldedCoinInfo`, in its own public ledger, and spends it later with `sendShielded`. The standard library supplies `insertCoin` on a `Map<K, QualifiedShieldedCoinInfo>`, which fills in the coin's Merkle index as the transaction lands. This is the pattern [Midnight's private tip jar tutorial](https://docs.midnight.network/tutorials/private-tip-jar/smart-contract) uses, and it is what this document means by the fee pot.

```compact
export ledger feePot: Map<Uint<64>, QualifiedShieldedCoinInfo>;
```

Keyed by the request's `inIndex`, the caller-chosen index every start circuit already discloses, one entry per fee taken. Fee values are public, as every pot coin is, which is fine: they are a known flat amount.

> **Note:** the pot cannot be one merged coin per token. Merging means every start spends the current pot coin and writes the merged one, so two starts of the same token in one block would spend the same nullifier and the second would fail. One coin per request keeps starts independent.

### Taking the Fee in a Start Circuit

The caller passes one coin worth `amountInMaximum + fee`. Today the circuit burns the whole coin. `sendImmediateShielded(coin, recipient, value)` sends only `value` of the coin to `recipient` and returns the remainder as a new change coin owned by the contract, so burning exactly `amountInMaximum` leaves a change coin worth exactly the fee. That change coin was created in this transaction, which is what `insertCoin` needs to record it in the pot.

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

  const fee = tokenFee(swapRequest.erc20AddressIn);
  assert(
    coin.value == swapRequest.amountInMaximum + fee,
    "Coin value must equal amountInMaximum plus fee"
  );
  receiveShielded(disclose(coin));
  // Burns amountInMaximum of the coin. The remainder, the fee, comes back as a change
  // coin the contract owns.
  const burnResult = sendImmediateShielded(
    disclose(coin),
    shieldedBurnAddress(),
    disclose(swapRequest.amountInMaximum)
  );
  if (fee > 0 as Uint<64>) {
    const feeCoin = burnResult.change.value;
    feePot.insertCoin(
      disclosedIndex,
      disclose(feeCoin),
      right<ZswapCoinPublicKey, ContractAddress>(kernel.self())
    );
  }

  // ...queue the request exactly as today...
}
```

The complete circuits are untouched: a failure still re-mints `amountInMaximum`, never the fee.

### How the Coins Flow

Three coins exist by the end of a start, and every one has a different nonce. The standard library derives each output nonce from the input nonce with a fixed domain separator, so no two coins in the flow can collide, and nothing in the circuit chooses a nonce by hand.

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
                                              │  sendImmediateShielded(coin, burn, amountInMaximum)
                                              │  spends nonce0 (publishes its nullifier)
                                              │  and creates two new coins:
                                              │
                               ┌──────────────┴───────────────────────────┐
                               │                                          │
                               ▼                                          ▼
             change = { color, nonce2, fee }                { color, nonce1, amountInMaximum }
             nonce2 = evolve("…nonce_evolve/2", nonce0)     nonce1 = evolve("…nonce_evolve", nonce0)
             owner: the contract                            owner: the burn address, gone for good
                               │
                               │  feePot.insertCoin(inIndex, change, self)
                               ▼
                    feePot[inIndex] = { color, nonce2, fee, mt_index }
```

Later, `withdrawFee` spends `nonce2` (publishing its nullifier) and creates a fourth coin, `nonce3 = evolve("…nonce_evolve", nonce2)`, owned by the recipient. A nonce is spent at most once on the whole chain, so the pot coin cannot be withdrawn twice even if the ledger entry were somehow left behind.

## Operator Withdrawal

One deployer-gated circuit pays a pot coin out in full and removes it:

```compact
export circuit withdrawFee(
  inIndex: Uint<64>,
  recipient: Maybe<Either<ZswapCoinPublicKey, ContractAddress>>
): [] {
  requireInitialised();
  requireDeployer();
  const key = disclose(inIndex);
  assert(feePot.member(key), "No such fee coin");
  const coin = feePot.lookup(key);
  const to = recipient.is_some
    ? recipient.value
    : left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
  sendShielded(coin, disclose(to), coin.value);
  feePot.remove(key);
}
```

The deployer withdraws one coin per call, reads the pot keys from the ledger, and sells the proceeds for gas off-chain. If the pot grows large, a later deployer-gated `mergeFees(a, b)` over `mergeCoin` can consolidate pairs without changing anything above.

### Why the Recipient Defaults to the Caller

A shielded output on Midnight is only a commitment and a nullifier: nothing on the chain names the recipient. A wallet discovers a coin sent to it by scanning every output for a ciphertext it can decrypt. That ciphertext is the coin's details encrypted to the recipient's encryption public key, which is a separate key from the coin public key a circuit's `Either<ZswapCoinPublicKey, ContractAddress>` carries. The circuit therefore only ever knows where to commit the coin, never how to encrypt it for the recipient, and the ciphertext has to be attached by the client when it builds the transaction.

Midnight.js attaches that ciphertext from a resolver that maps coin public keys to encryption keys. The resolver knows the caller's own wallet and the burn address, and a third party only if the client is given the mapping explicitly (`additionalCoinEncPublicKeyMappings` on the call). An output to an unknown recipient is refused before the transaction is built, since a wrongly encrypted output is a coin the recipient owns and can never find. A contract recipient needs no ciphertext at all: a contract discovers its coins from its own ledger, which is why the pot works.

So the `none` default pays `ownPublicKey()`, the deployer's wallet, which always resolves. The explicit `some` form is for a contract recipient, or for a third-party wallet whose encryption key the deployer's client has been given. A wallet that knows the exact coin ahead of time can also register it with `watchFor` and notice the commitment without any ciphertext, which is the fallback if a mapping is ever missed.
