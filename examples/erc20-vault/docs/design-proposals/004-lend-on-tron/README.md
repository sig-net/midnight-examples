# Lend On Tron

This design proposal exists to give the vault's Tron side the supply and redeem its Ethereum side already has.

## The Missing Supply and Redeem

On Ethereum the vault lends through the stata pair. A supply burns underlying vault coins at `startSupply`, and the vault's account then calls `deposit(amount, vaultEvmAddress)` on the `stataToken` ERC-4626 wrapper. A redeem burns share coins at `startRedeem`, and the account then calls `redeem(shares, vaultEvmAddress, vaultEvmAddress)`. An ERC-4626 `deposit` pulls the underlying from its caller under an allowance, mints shares to the receiver and returns how many it minted. Its `redeem` burns the owner's shares, pays the receiver the underlying they are worth and returns that amount. The complete circuits mint exactly those returned numbers as shielded coins.

After the Tron deposit of [proposal 002](../002-tron-deposit/README.md) and the withdraw of [proposal 003](../003-withdraw-to-tron/README.md), TRC-20s move into and out of the vault, but the vault cannot lend them. The pair this example targets on Tron is Tron USDT and jUSDTv2, the ERC-4626 share token of JustLend V2, a lending protocol on Tron. Two facts stand in the way of a plain copy of the Ethereum circuits.

The first is size. Midnight's mint API takes a `Uint<64>`, so one vault coin holds at most `2^64 - 1` base units: about 18.4 tokens of an 18-decimal token, and jUSDTv2 shares carry 18 decimals. A deposit or withdrawal is not at risk, since its start refuses an amount at or above `2^64` before anything runs. The shares a supply gets back are only known once it has run, and if a plain copy of `completeSupply` received `2^64` base units or more it could never succeed and the funds would stay locked. The Ethereum side avoids this by having the operator choose a stata pair whose total supply stays below `2^64` base units, which 6-decimal tokens meet and 18-decimal tokens do not. No circuit checks it.

The second is the chain. Every lend call is a Tron transaction that the vault's own Tron account signs and pays for, exactly as a Tron withdrawal is: it has no account nonce, names a reference block and a validity window, and pays for its energy and bandwidth from staked resources or by burning TRX, under a fee limit that caps the energy the call may use.

## Proposed Design

Every listed Tron token carries a factor, fixed when it is listed. Its coins count in units of that many base units: requests and coins name coin units, and calldata carries coin units times the factor. The vault lists jUSDTv2 at factor `10^12`, so its coins have 6 decimals, and Tron USDT at factor 1, so nothing changes for it.

The deployer then pairs one listed underlying with one listed ERC-4626 share token, once, and three new actions mirror their Ethereum twins: `startTronApprove` grants the share token an allowance on the underlying, `startTronSupply` deposits underlying for shares, and `startTronRedeem` redeems shares for underlying. Each is a Tron transaction the vault's own account signs, with a fee limit of its own and under the window checks proposal 003 gives a withdrawal. The shares or assets the chain returns are floored to whole coin units, so the vault never mints more than the chain returned. A failed or unviable supply or redeem re-mints the amount or the shares. A supply or redeem nobody sent in time is refunded the same way once the send refuses it, 60 seconds before its expiration. The fee is kept in every case.

Which operations pay, the factor, the pair, each action, the fee limits, and what lending changes in proposals 002 and 003 are design questions for the sections that follow.

## Which Operations Pay

Supply and redeem pay a flat fee in the surrendered vault token, as [proposal 001](../001-take-fees-on-vault-operations/README.md) sets out for the Ethereum supply and redeem: the underlying's `supply` fee for a supply and the share token's `redeem` fee for a redeem, each in that token's coin units and minted to the fee recipient by `takeFee`. The approve pays none, since it is deployer-gated, as `startApproveStata` pays none. The fee is kept on every verdict: a failed or unviable request re-mints the principal alone, and `refundUnsentTronSupply` and `refundUnsentTronRedeem` keep it as a failed request does.

## A Factor Per Tron Token

A token's base unit is the smallest amount its contract counts: `10^-6` USDT for 6-decimal Tron USDT, `10^-18` of a share for 18-decimal jUSDTv2. The deployer lists a token at a factor of `10^s`, where `s` is the number of decimals to shift away: one vault coin unit stands for `10^s` base units, so a coin's `Uint<64>` reaches `(2^64 - 1) × factor` base units. A token listed at a factor above 1 is a shifted token, and one listed at factor 1 is unshifted. At factor `10^12` one jUSDTv2 coin unit is `10^12` share base units, about `1.007 × 10^-6` USDT, and one coin holds up to about `1.8 × 10^13` whole shares. Every Tron amount the vault handles is in coin units: deposit and withdraw amounts, supply amounts, redeem shares, and the token's fees.

### State Update

Tron tokens are currently listed under the `AllowedTokenConfig` the ERC20s use, which holds only fees:

```compact
export ledger allowedTronTokens: Map<Bytes<20>, AllowedTokenConfig>;
```

This becomes a struct of its own, so the Ethereum listing is unchanged:

```compact
// A Tron token's coins count in units of `factor` base units (10^s, 1 for an unshifted
// token), so a coin's Uint<64> reaches (2^64 - 1)·factor base units. The factor is fixed at
// listing: changing it would reprice every coin already minted. Fees are in coin units.
// colour is tronCoinColour(token, factor), fixed with it: computing it once here keeps the
// hash out of every circuit that mints or checks a Tron coin.
export struct AllowedTronTokenConfig {
  fees: TokenFees;
  factor: Uint<64>;
  colour: Bytes<32>;
}

export ledger allowedTronTokens: Map<Bytes<20>, AllowedTronTokenConfig>;
```

The factor lives in the listing and not in each request because a coin carries only its colour, value and nonce: the vault reads every coin of a token in the listing's units, so a changed factor would reprice every coin already minted.

### Configuration Circuits

`addAllowedTronToken` takes the factor alongside the fees, refuses a factor of 0 and a token already listed, and stores the colour. A second deployer circuit reprices the fees and keeps the factor and the colour:

```compact
export circuit addAllowedTronToken(tokenAddress: Bytes<20>, fees: TokenFees, factor: Uint<64>): [] {
  requireInitialised();
  requireDeployer();
  assert(tokenAddress as Field != 0 as Field, "TRC-20 address cannot be zero");
  assert(factor > 0 as Uint<64>, "Factor must be positive");
  assert(!allowedTronTokens.member(disclose(tokenAddress)), "TRC-20 already allowed");
  allowedTronTokens.insert(
    disclose(tokenAddress),
    disclose(AllowedTronTokenConfig {
      fees: fees,
      factor: factor,
      colour: tronCoinColour(tokenAddress, factor),
    })
  );
}

// Reprices a listed Tron token and keeps its factor. A request keeps the fee it was
// started with.
export circuit setTronTokenFees(tokenAddress: Bytes<20>, fees: TokenFees): [] {
  requireInitialised();
  requireDeployer();
  const config = tronTokenConfig(tokenAddress);
  allowedTronTokens.insert(
    disclose(tokenAddress),
    disclose(AllowedTronTokenConfig { ...config, fees: fees })
  );
}
```

Since a token can be listed only once, `setTronTokenFees` is the only way to reprice it, and it cannot touch the factor. A fee is in coin units: for jUSDTv2 a fee of 1 is `10^12` share base units, about `10^-6` USDT. A reprice does not reach a request already started, whose fee was taken at its start.

### Colour

A shifted token's coins get their own domain separator, which hashes the factor in, so a coin's colour names both its token and its factor:

```compact
export pure circuit tronCoinColour(tokenAddress: Bytes<20>, factor: Uint<64>): Bytes<32> {
  return factor == 1
    ? vaultTronTokenDomainSeparator(tokenAddress)
    : upgradeFromTransient(transientHash<Vector<3, Bytes<32>>>([
        pad(32, "vault:token:tron:shifted:"),
        tokenAddress as Field as Bytes<32>,
        factor as Field as Bytes<32>
      ]));
}
```

An unshifted token keeps `vaultTronTokenDomainSeparator`, so Tron USDT at factor 1 keeps its colour. The listing's `colour` field holds the result, the domain separator the coin's colour is derived from. It is computed once at listing and stored, which keeps the hash out of every circuit that mints or checks a Tron coin: a start compares `coin.color` with `tokenType(colour, kernel.self())`, and a complete or refund mints under the stored `colour`.

### Converting Between Units

Two pure circuits and a witness carry every conversion:

```compact
// A Tron amount in coin units as the token's base units, which calldata carries.
export pure circuit tronBaseOfUnits(units: Uint<64>, factor: Uint<64>): Uint<128> {
  return (units * factor) as Uint<128>;
}

// floor(base / factor) given the caller's quotient q, which this checks: Compact cannot
// divide. A base whose quotient exceeds Uint<64> has no q to pass.
export pure circuit tronUnitsOfBaseFloor(base: Uint<128>, factor: Uint<64>, q: Uint<64>): Uint<64> {
  const low = tronBaseOfUnits(q, factor);
  assert(low <= base, "Quotient too large");
  assert(((base - low) as Uint<128>) < (factor as Uint<128>), "Quotient too small");
  return q;
}

// floor(base / factor), which tronUnitsOfBaseFloor checks.
witness unitsOfBase(base: Uint<128>, factor: Uint<64>): Uint<64>;
```

An amount the client chooses (a deposit, a withdrawal, a supply amount, redeem shares) is whole coin units, so `tronBaseOfUnits` converts it exactly. An amount the chain decides (the shares a deposit returns, the assets a redeem returns) arrives in base units and is rounded down to coin units. The caller's `unitsOfBase` witness computes the quotient and `tronUnitsOfBaseFloor` checks it: a larger quotient fails the first assertion and a smaller one the second, so the only quotient that passes is the floor. Rounding down keeps every minted coin backed, and the remainder, under one coin unit per request, stays in the vault's Tron account. The quotient is a `Uint<64>`, so only the quotient by the minted token's factor must stay below `2^64`, not the base amount the chain returned.

> **Note:** the alternative of listing jUSDTv2 at factor 1, so that share coins count share base units the way `stataToken` coins do on Ethereum, was dropped. It would need the shares a supply returns to stay below `2^64` base units, about 18.4 shares, so any supply returning more could never settle.

### Tron Deposit and Withdraw

The factor belongs to the token, not to lending, so the Tron deposit of proposal 002 and the withdraw of proposal 003 use it too. `sendTronDeposit` and `tronWithdrawEvent` put the request's amount times the factor in the transfer's calldata, while the request and the minted or burned coin count coin units. The deposit mints under the stored `colour`, and the withdraw checks, burns and refunds under it. A shifted token therefore moves through a Tron deposit or withdrawal like any other: share coins can leave the vault as jUSDTv2 without a redeem first, and a deposit of jUSDTv2 mints the same coins a supply does. At factor 1 neither flow changes.

## The Lend Pair

The Ethereum pair is fixed in `initialise()`. The Tron pair is recorded later, since both tokens must be listed first and `addAllowedTronToken` runs only after `initialise()`. Three ledger fields hold it:

```compact
// The pair setTronLendPair records, and the smallest supply, in underlying coin units, it
// admits: a supply too small to return one share coin unit would mint nothing.
export ledger tronLendUnderlying: Bytes<20>;
export ledger tronLendShareToken: Bytes<20>;
export ledger tronLendMinSupply: Uint<64>;
```

A one-shot deployer circuit sets them:

```compact
export circuit setTronLendPair(underlying: Bytes<20>, shareToken: Bytes<20>, minSupply: Uint<64>): [] {
  requireInitialised();
  requireDeployer();
  assert(tronLendShareToken as Field == 0 as Field, "Tron lend pair already set");
  assert(underlying as Field != 0 as Field, "Underlying cannot be zero");
  assert(shareToken as Field != 0 as Field, "Share token cannot be zero");
  assert(underlying != shareToken, "Underlying and share token must differ");
  requireTronTokenAllowed(underlying);
  requireTronTokenAllowed(shareToken);
  assert(minSupply > 0 as Uint<64>, "Minimum supply must be positive");
  tronLendUnderlying = disclose(underlying);
  tronLendShareToken = disclose(shareToken);
  tronLendMinSupply = disclose(minSupply);
}
```

Fees and factors come from each token's listing, so the pair adds nothing but the two addresses and the minimum. The lend circuits take no token argument: approve, supply and redeem read the two addresses from the ledger, as their Ethereum twins read `stataUnderlying` and `stataToken`, and each refuses to start until the pair is set (`requireTronLendPair`). The minimum exists because a supply too small to return one share coin unit would mint a share coin worth nothing, so `startTronSupply` refuses an amount below `tronLendMinSupply`. The example sets it to 1,000,000 coin units, one USDT.

## Tron Approve

The share token's `deposit` pulls the underlying from the vault's Tron account, so that account first grants the share token an allowance on the underlying, as `startApproveStata` does on Ethereum. The token and the spender are both pinned to the pair, since the vault's Tron account holds the underlying that backs users' coins, and a free spender argument would let the deployer point that allowance anywhere. `startTronApprove` takes only an input index and the deployer's `TronTxWindow`, copies the approve fee limit (see Fee Limits Per Action), and passes the same window checks as a withdrawal.

`tronApproveEvent` builds `approve(address,uint256)` on `tronLendUnderlying` with `tronLendShareToken` as the spender and `unlimitedAllowance()`, `2^128 - 1`, as the amount, so one approval lasts until that many base units have moved through it. `startTronSupply` does not check that an approval has executed: the deployer approves once after `setTronLendPair`. The approve carries no binding word, since it is deployer-gated and only the deployer's own approvals could repeat its fields, so the deployer gives each approval a fresh window. `sendTronApprove` is permissionless, and `completeTronApprove`, gated to the deployer who started the approval, checks an executed output against the attestation and otherwise only closes the request: an approval surrendered nothing, so no verdict mints anything.

> **Note:** the alternative of a refund circuit for an approval nobody sent in time, as the supply and redeem have, was dropped. An approval surrenders nothing at its start, so an unsent one strands nothing and the deployer starts another.

## Tron Supply

A supply is `startSupply` with proposal 003's Tron checks, on the pinned pair.

### The Supply Arguments

A supply's arguments hold what fixes its Tron transaction:

```compact
// Holds what fixes the Tron transaction and no fee. binding is the request's ownership
// commitment, which the start computes and the queued entry already publishes: as the last
// calldata word it gives every request its own Tron transaction and request id, so a copy of
// a public start (same amount and window) can neither hold the original at the flush nor
// share its request id, and no request can be settled by another's receipt.
export struct TronSupplyArgs {
  request: TronSupplyRequest;
  tx: TronTxFields;
  binding: Bytes<32>;
}
```

Its `TronSupplyRequest` carries only the amount, in underlying coin units, and the pair fixes everything else. The binding is proposal 003's ownership-commitment word, which lending appends to the share token's `deposit` exactly as the withdraw appends it to a transfer. jUSDTv2's ABI decoder ignores the extra word.

The args hold no fee, unlike the Ethereum `SupplyArgs`, which proposal 001 gives a `fee` field, and unlike `TronWithdrawArgs`, which keeps the `fee` field proposal 003 gives it. The args hash goes into the request's index at the flush, so keeping the fee out means the index changes only when the Tron transaction does. The fee stays public anyway: the start discloses the surrendered coin, whose value is the amount plus the fee. Proposal 001's fee discovery reads a fee coin's value from the `fee` recorded in the request's args, which these args do not have, so for a Tron supply or redeem it takes the value as the coin's value less the amount.

### The Circuits

`startTronSupply` takes an input index, the request, the supplier's `TronTxWindow` and one coin. After refusing an amount below `tronLendMinSupply` or above `2^64 - 1`, it takes the coin and queues the request:

```compact
export circuit startTronSupply(
  inIndex: Uint<64>,
  supplyRequest: TronSupplyRequest,
  tronTx: TronTxWindow,
  coin: ShieldedCoinInfo
): [] {
  // ...the initialisation, pair, amount and index checks...
  const config = tronTokenConfig(tronLendUnderlying);
  const fee = config.fees.supply;
  const colour = config.colour;
  assert(
    coin.color == tokenType(colour, kernel.self()),
    "Coin is not the vault token for the underlying"
  );
  assert(
    coin.value == (supplyRequest.amount + fee) as Uint<128>,
    "Coin value must equal the supply amount plus fee"
  );
  takeFee(colour, coin, fee);

  const commitment = ownershipCommitment(inIndex, callerSecretKey());
  const args = disclose(TronSupplyArgs {
    request: supplyRequest,
    tx: tronVaultTxFields(tronTx, vaultTronFeeLimits.supply),
    binding: commitment,
  });
  assertTronTriggerSmartContractTxParamsV1<3>(tronSupplyEvent(args).txParams);
  assertTronWindow(args.tx.expiration, tronStartMinRemainingSeconds());
  // ...queue the request as a Tron withdrawal is queued...
}
```

`tronVaultTxFields` builds the request's signed fields from the supplier's window and the supply fee limit. `tronSupplyEvent` builds `deposit(uint256,address)` on `tronLendShareToken` with three calldata words: the amount times the underlying's factor, `vaultEvmAddress` as the receiver, and the binding. The receiver is pinned so the shares land in the vault's Tron account, which backs the coins minted for them, and it is `vaultEvmAddress` since the vault's Tron address is the `0x41` prefix followed by those 20 bytes and the ABI word carries only the 20. `sendTronSupply` is permissionless, as `sendTronWithdraw` is. `completeTronSupply` settles every verdict, mints to the caller, and is gated to the supplier:

```compact
export circuit completeTronSupply(
  requestId: RequestId,
  serializedOutput: Bytes<32>,
  mintNonce: Bytes<32>,
): [] {
  // ...the initialisation check, then settle the request and close its maps...
  const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
  if (record.outputKind == OutputKind.executed) {
    const output = disclose(serializedOutput);
    assert(
      verifyAttestedOutputV1<32>(output, record.serializedOutputLength, record.outputHash),
      "Output does not match the attestation"
    );
    const share = tronTokenConfig(tronLendShareToken);
    const shares = checkedTruncationU128(output);
    mintShieldedToken(
      share.colour,
      tronUnitsOfBaseFloor(shares, share.factor, disclose(unitsOfBase(shares, share.factor))),
      disclose(mintNonce),
      caller
    );
  }
  if (outcomeRefunds(record.outputKind)) {
    mintShieldedToken(
      tronTokenConfig(tronLendUnderlying).colour,
      args.request.amount as Uint<64>,
      disclose(mintNonce),
      caller
    );
  }
}
```

The MPC attests the `uint256` the deposit returned as 32 little-endian bytes, and `checkedTruncationU128` refuses one at or above `2^128` before the floor. On a failed or unviable verdict the share token took nothing, so the surrendered amount is re-minted and the presented output is ignored. A supply nobody sent before the send refused it is refunded by `refundUnsentTronSupply`, which re-mints the amount once, to the supplier, as `refundUnsentTronWithdraw` does for a withdrawal.

## Tron Redeem

The share token's `redeem(shares, vaultEvmAddress, vaultEvmAddress)` burns shares held by its owner, the last argument, so with the vault's own account as the owner no allowance is involved. `startTronRedeem` mirrors `startTronSupply` on the share token: it requires shares above zero and below `2^64`, one coin of the share token's colour worth the shares plus the share token's `redeem` fee, and copies the redeem fee limit. `TronRedeemArgs` holds no fee and binds the request to its requester as `TronSupplyArgs` does. `tronRedeemEvent` builds `redeem(uint256,address,address)` on `tronLendShareToken` with four calldata words: the shares times the share token's factor, `vaultEvmAddress` as the receiver, `vaultEvmAddress` again as the owner, and the binding. One `evmAddressAbiWord` serves both addresses, since each costs about 7,000 constraint rows and a second would push the send circuit past `2^15` rows, into the next power-of-two circuit size.

`completeTronRedeem` is `completeTronSupply` with the roles swapped: an executed redeem mints the attested assets floored to underlying coin units, and a failed or unviable one re-mints the surrendered shares. `refundUnsentTronRedeem` re-mints the shares of a redeem nobody sent in time.

## How the Coins Flow

A supply burns underlying coins on Midnight and turns the vault's Tron USDT into shares, and a redeem burns share coins and turns shares back into USDT. In both, the vault's Tron account is what backs the coins, and a refund of a request nobody sent opens only once the send refuses it. The flush, the signature, the broadcast and the attestation run as in proposal 003's diagram and are left out. Below, `x` is the number of share base units the deposit returned and `y` the number of underlying base units the redeem returned, and the two factors are the underlying's and the share token's. The remainder of `x` or `y` stays in the vault's Tron account, and a failed, unviable or unsent request moves nothing there.

```text
supplier's wallet         contract                                              vault's Tron account
─────────────────         ────────                                              ────────────────────

underlying coin { color, nonce0, amount + fee }
    │
    │  startTronSupply: takeFee burns the coin whole
    ▼
                          amount + fee  ──▶  burn address
                          fee, if any   ──▶  collection address

                          the request, queued and flushed
                              │
                              │  sendTronSupply (anyone): the MPC signs
                              │  deposit(amount × underlying factor,
                              │    vaultEvmAddress, binding)
                              └──────────────────────────────────────────────▶  the underlying leaves
                                                                                x share base units arrive

                          completeTronSupply (the supplier)
executed            ◀──   share coin { color, mintNonce, floor(x / share factor) }
failed or unviable  ◀──   underlying coin { color, mintNonce, amount }

                          refundUnsentTronSupply (the supplier)
never sent          ◀──   underlying coin { color, mintNonce, amount }

redeemer's wallet         contract                                              vault's Tron account
─────────────────         ────────                                              ────────────────────

share coin { color, nonce0, shares + fee }
    │
    │  startTronRedeem: takeFee burns the coin whole
    ▼
                          shares + fee  ──▶  burn address
                          fee, if any   ──▶  collection address

                          the request, queued and flushed
                              │
                              │  sendTronRedeem (anyone): the MPC signs
                              │  redeem(shares × share factor,
                              │    vaultEvmAddress, vaultEvmAddress, binding)
                              └──────────────────────────────────────────────▶  the shares leave
                                                                                y underlying base units arrive

                          completeTronRedeem (the redeemer)
executed            ◀──   underlying coin { color, mintNonce, floor(y / underlying factor) }
failed or unviable  ◀──   share coin { color, mintNonce, shares }

                          refundUnsentTronRedeem (the redeemer)
never sent          ◀──   share coin { color, mintNonce, shares }
```

## A Supply and Redeem in Numbers

Take a supply of 100 USDT. Tron USDT has factor 1, so the request names 100,000,000 coin units, the supplier's coin is worth 100,000,000 plus the supply fee, and the deposit's calldata carries 100,000,000 base units. Suppose the share token returns 99,285,280,840,766,226,500 share base units. The supplier's wallet computes the quotient by `10^12`, 99,285,280, and `tronUnitsOfBaseFloor` checks it: `99,285,280 × 10^12` = 99,285,280,000,000,000,000 is at most the returned shares, and the difference, 840,766,226,500, is below `10^12`. `completeTronSupply` mints 99,285,280 share coin units, and the 840,766,226,500 share base units left over stay in the vault's Tron account. A later redeem surrenders that coin. The coin must be worth the shares plus the share token's redeem fee, so the request names 99,285,280 minus that fee as its shares, and the `redeem` calldata carries that many times `10^12` share base units. If yield has accrued by then and the share token pays back 100,712,345 USDT base units, `completeTronRedeem` mints 100,712,345 USDT coin units, unchanged at factor 1.

## Fee Limits Per Action

Proposal 003 gives the vault's Tron transactions one fee limit. Lending adds an approve, a supply and a redeem, and a deposit or redeem on the share token uses more than ten times the energy of a USDT approve, so the limit becomes one per action:

```compact
// The fee limit, in sun, of each kind of Tron transaction the vault's own account signs.
export struct VaultTronFeeLimits {
  withdraw: Uint<64>;
  approve: Uint<64>;
  supply: Uint<64>;
  redeem: Uint<64>;
}
```

One ledger field holds them:

```compact
// The fee limits, in sun, of the vault's Tron transactions: set by initialise() and
// setGasParams(), read at start.
export ledger vaultTronFeeLimits: VaultTronFeeLimits;
```

`initialise()` sets them to 100 TRX for a withdraw, 50 for an approve and 150 each for a supply and a redeem. A deposit on jUSDTv2 uses about 397k energy and a redeem about 395k, against about 34k for a USDT approve. At mainnet's 100 sun per unit of energy, and with no staked energy, that is about 40, 39 and 3.4 TRX. The limits leave room for Tron's dynamic energy penalty, a surcharge on heavily used contracts, to rise. `setGasParams` takes all four as one `newTronFeeLimits` argument and checks each is positive and fits Tron's signed 64-bit field (`tronInt64Max()`), and each start copies its own action's limit into the request's args through `tronVaultTxFields`, so a request keeps the limit it was started with. A call that runs out of energy fails on Tron, the MPC attests it failed and a withdraw, supply or redeem is refunded, while an approve only closes, but the TRX it burned stays burned.

## What Lending Changes in Proposals 002 and 003

Lending builds on proposals 002 and 003 and changes six things in them.

A Tron token is listed once. `addAllowedTronToken` takes a factor and refuses a token already listed, so the repricing proposal 003 does by calling it again moves to `setTronTokenFees`, and the listing becomes an `AllowedTronTokenConfig` with its factor and `colour` (see A Factor Per Tron Token).

The deposit and the withdraw count coin units: their calldata carries the amount times the token's factor, and they mint and check under the stored `colour` where proposals 002 and 003 use `vaultTronTokenDomainSeparator` (see Tron Deposit and Withdraw). At factor 1 the calldata and the colour are the ones those proposals describe.

The single `vaultTronFeeLimit` becomes `vaultTronFeeLimits`, one limit per action, and `setGasParams` takes `newTronFeeLimits` in place of `newTronFeeLimit` (see Fee Limits Per Action).

The withdraw's window helpers lose the withdraw from their names, since every request the vault's Tron account signs now uses them: `tronWithdrawStartMinRemainingSeconds` becomes `tronStartMinRemainingSeconds`, `tronWithdrawSendMinRemainingSeconds` becomes `tronSendMinRemainingSeconds`, `tronWithdrawCapMarginSeconds` becomes `tronCapMarginSeconds`, `assertTronWithdrawWindow` becomes `assertTronWindow`, and `assertTronWithdrawSendClosed` becomes `assertTronSendClosed`, whose refusal now names any Tron request rather than a withdrawal. The deposit-expiry circuit proposal 002 plans would use it under its new name. `tronTokenConfig`, which returns a Tron token's whole listing, replaces the fee lookup the Tron withdraw's start uses. Three shared helpers are new, besides the factor and lend circuits described above: `tronVaultTxFields` builds the signed fields from the requester's `TronTxWindow` and the action's fee limit, `assertTronFeeLimit` is the bound `setGasParams` checks on each limit, and `removeUnsentTronRequest` is the removal every refund-unsent circuit shares.

`Action` gains `tronApprove`, `tronSupply` and `tronRedeem`. The nonce read `startReplaceNonce` makes, `sentVaultNonce`, refuses them as it refuses a Tron withdrawal: a Tron request has no vault nonce, and a Tron transaction that never lands expires and is attested unviable instead.

The ledger gains fields, so the compiled ledger path of every request map moves again, and with it the path each send circuit names in its notification to the MPC.

Apart from these changes, proposals 002 and 003 carry over. Lend requests settle against `tronLastSeen`, as every Tron request does. The Tron USDT false-return rule does not reach lending: a supply and a redeem return a `uint256`, not a bool, and `completeTronApprove` never decodes the bool its output carries.

## How Clients and Operators Deal With It

A client drives a supply or redeem as it drives the Ethereum one, with proposal 003's Tron steps: a fresh random input index, a window on the solidified head, the MPC's signature polled and the signed transaction broadcast, then the attestation queued and the request settled. At complete, the caller's `unitsOfBase` witness supplies the quotient, so the client passes no extra argument. If a request was never sent, the requester waits until the send refuses it and calls `refundUnsentTronSupply` or `refundUnsentTronRedeem` with the request's input index and a random `mintNonce`.

The deployer lists both tokens before pairing them, and must get each factor right the first time, since a token's factor cannot change once it is listed. The contract itself accepts any positive factor, so the deploy tooling refuses to pair a share token unless the deployer has given it that token's factor and the listing matches it. It can refuse at listing only when the deployer has already told it which token is the share token, and otherwise lists a token without a given factor at factor 1. After the pair, the deployer runs `startTronApprove` once. The operator keeps TRX, or staked energy, in the vault's Tron account for every withdraw, approve, supply and redeem it signs, and reprices the Tron fees with `setTronTokenFees`, which keeps each token's factor.

## Residual Risk

The vault trusts the share token's code as the Ethereum side trusts the stata pair: no cap bounds what its Tron account holds in it, and the vault mints whatever shares or assets the MPC attests the call returned. A share token that reported more than it minted or paid would make the vault mint coins its Tron account does not hold. The approval is unlimited and covers all the underlying the vault's Tron account holds, including what backs coins from plain Tron deposits, so whoever controls the share token's code can reach all of it, not only what was supplied. For jUSDTv2, that trust accepts three things: an upgradable proxy whose admin is one key, source code that Tronscan (Tron's block explorer) does not show as verified, and a 10% performance fee on yield. jUSDTv2 has no deployment on Nile, Tron's test network, so a vault deployed against Nile has no lend pair.

The binding word depends on the share token's ABI decoder ignoring trailing calldata, which jUSDTv2's does. An upgrade that refused it would make every supply and redeem fail on Tron and be refunded with the fee kept. A share token whose return data stopped decoding as a `uint256` would be worse: the MPC leaves such an executed request without a response, so it never settles and its coin stays burned.

A wrong factor cannot be corrected, since the factor is fixed at listing, and the contract checks only that a factor is positive. A share token listed with too small a factor lets a supply return shares whose quotient reaches `2^64`, and that supply can never settle: its coin stays burned and its shares sit in the vault's Tron account with no coin for them. One listed with too large a factor floors away more per request. The only guard is the deploy tooling, which refuses to pair a share token whose factor the deployer has not given it. It cannot tell whether that factor is right.

The remainder of each executed supply or redeem, under one coin unit, stays in the vault's Tron account, and no circuit moves it. A `tronLendMinSupply` set high enough, as the example's one USDT is, keeps a real supply above one share coin unit. The contract checks only that it is positive. It is fixed with the pair, and an executed supply whose shares floor to zero still settles, with a coin of value 0.

The fees drift as proposal 001's residual risk describes, and the fee limits drift with them. Each Tron fee is a fixed amount in coin units and each fee limit a fixed amount of sun, while the price of energy, TRX and the tokens moves, so the operator reprices the fees with `setTronTokenFees` and resets the limits with `setGasParams` whenever they have drifted.
