# Withdraw To Tron

This design proposal exists because the vault takes deposits of TRC-20s, Tron's counterpart of ERC20 tokens, but has no way to send them back.

## The Missing Withdraw

A Tron deposit, which [proposal 002](../002-tron-deposit/README.md) describes, ends with `completeTronDeposit` minting a shielded Tron vault token, whose colour comes from `vaultTronTokenDomainSeparator`. Nothing burns that coin for a transfer on Tron: `startWithdraw` accepts only a coin of an ERC20's colour, from `vaultTokenDomainSeparator`, and the withdraw it starts sends an EVM transaction. Tron value that enters the vault therefore has no way out.

The Ethereum withdraw cannot simply be pointed at Tron, because it relies on the vault account's EVM nonce in three places. First, the flush gives every vault-signed request the next `vaultAccountNonce`, which makes each transaction unique. Second, a transaction that can never be mined is replaced through `startReplaceNonce`, which has the MPC sign a replacement at the same nonce. Third, an unviable verdict means that nonce was consumed by another transaction.

A Tron account has no nonce, as proposal 002 sets out for the deposit. Instead, a Tron transaction names a recent block as its reference, which Tron calls TaPoS (transaction as proof of stake), and carries a validity window. The reference is given as `refBlockBytes` and `refBlockHash`: two bytes of the block's number and eight bytes of its id. The window is a `timestamp` and an `expiration`, both in milliseconds. A transaction can land only after its reference block, while that block is among the chain's most recent 65,536, and before its expiration, which a node accepts at most 24 hours past the head block's time. Its id is the SHA-256 of its raw bytes, so the same fields always name the same transaction, which Tron takes only once.

## Proposed Design

The vault gains a Tron withdraw that runs the same six steps as the Ethereum withdraw (start, flush the request, send, queue the attestation, flush the attestation, complete) and changes only what Tron needs. `startTronWithdraw` burns a Tron vault coin worth the amount plus the token's withdraw fee, `sendTronWithdraw` asks the MPC to sign `transfer(destTronAddress, amount)` on the TRC-20 from the vault's own Tron account, and `completeTronWithdraw` keeps the burn when the transfer moved the tokens and re-mints the amount when it did not. The fee is taken and kept as [proposal 001](../001-take-fees-on-vault-operations/README.md) describes for the Ethereum withdraw.

Where the Ethereum withdraw relies on the nonce, the Tron withdraw does four things instead. First, the withdrawer picks the reference block and the window, and the vault sets the fee limit. Second, the contract refuses a request the MPC would drop, one with fields Tron cannot encode or a window the MPC would not admit, before the MPC ever sees it. Third, a transaction that never lands expires, and once its window has closed the MPC attests it unviable and the amount is refunded, provided the MPC can find its reference block (see Who Picks the Window). Fourth, every transfer carries the request's ownership commitment as a third calldata word, so each withdrawal names its own Tron transaction. The vault therefore needs no nonce and no replacement transaction.

One case the Ethereum withdraw does not have needs a circuit of its own: a withdrawal that nobody sent before the send stopped admitting it is refunded by `refundUnsentTronWithdraw`, with the amount returned and the fee kept.

The request and its state, which account signs and pays, who picks the window, what the contract refuses, what replaces the nonce, how a withdrawal is told apart from a copy, the refund of an unsent withdrawal and how a withdrawal settles are design questions for the sections that follow.

## The Withdraw Request

A Tron withdrawal is an action of its own, with its own request and its own maps beside the Ethereum withdraw's.

### State Update

`Action` currently ends at the Tron deposit:

```compact
export enum Action { deposit, withdraw, swap, supply, redeem, approve, replaceNonce, tronDeposit }
```

This becomes:

```compact
export enum Action { deposit, withdraw, swap, supply, redeem, approve, replaceNonce, tronDeposit, tronWithdraw }
```

The rest of the state follows the Ethereum withdraw's: `tronWithdrawArgsMap` holds each request's arguments from start until it is completed or refunded unsent, and `bidirectionalTronWithdrawMap` holds each sent `SignBidirectionalEvent`, whose calldata has three words rather than two. The request names the TRC-20, the amount and `destTronAddress`: a Tron address is a `0x41` byte followed by 20 bytes, and `destTronAddress` is those 20 bytes, which is what the transfer's ABI address argument carries. The new ledger fields also move the compiled ledger path of every request map. Each send circuit names its map's path in the notification it sends the MPC, and the MPC reads the request at that path, so every send's notification path and every client's request path change with them.

## Which Account Signs and Pays

The vault's own Tron account signs every withdrawal. The MPC derives it from the path `"vault"`, the same path the vault's EVM account uses, so its Tron address is `tronAddress(vaultEvmAddress)`: the vault's EVM address behind a `0x41` prefix. The transfer moves no TRX, Tron's native coin, so its `callValue` is 0.

A Tron transaction pays for energy and bandwidth, Tron's counterparts of gas for contract execution and for transaction size, either from resources its account has staked TRX for or by burning TRX, and its fee limit caps the energy a contract call may use, staked or paid for by burning TRX. The vault's account pays, so the fee limit is the vault's own setting rather than the withdrawer's, just as the Ethereum withdraw takes the vault's gas settings. A Tron deposit is the other case: the depositor's own derived account signs it, and `startTronDeposit` takes the fee limit the depositor chose.

### The Fee Limit

The vault's fee limit sits beside its EVM gas settings, in sun (a millionth of a TRX). `initialise()` sets it to 100 TRX, and `setGasParams` gains an eighth parameter, `newTronFeeLimit`, which must be positive and fit the signed 64-bit field Tron's transaction encoding gives it (`tronInt64Max()`). The contract checks only that bound: Tron itself refuses a transaction whose fee limit exceeds its `getMaxFeeLimit` chain parameter, 15,000 TRX on mainnet. The limit is one ledger field, and a request keeps the limit it was started with (see Who Picks the Window):

```compact
// The fee limit, in sun, of the vault's Tron transactions: set by initialise() and
// setGasParams(), read at start.
export ledger vaultTronFeeLimit: Uint<64>;
```

### The Fee

The withdraw fee is the `withdraw` field of the TRC-20's entry in `allowedTronTokens`, which `addAllowedTronToken` already fills, and the start refuses an unlisted TRC-20 ("TRC-20 not allowed"). It is charged in the surrendered Tron vault token and, when it is positive, minted to the fee recipient by `takeFee`, which now takes the domain separator of the coin's colour (`coinDomainSeparator`) instead of an ERC20 address, so the same helper serves an ERC20 colour and a Tron colour. The fee charged is recorded as `fee` in `TronWithdrawArgs`, and no circuit refunds it.

## Who Picks the Window

The withdrawer names the reference block and the window at start, in a `TronTxWindow`:

```compact
// The withdrawer's TaPoS reference and validity window, in Tron's milliseconds.
export struct TronTxWindow {
  refBlockBytes: Bytes<2>;
  refBlockHash: Bytes<8>;
  timestamp: Uint<64>;
  expiration: Uint<64>;
}
```

The start copies them into the request's arguments together with the vault's fee limit at that moment, so a later `setGasParams` does not change a request in flight. The arguments, `TronWithdrawArgs`, also carry `binding`, the word that gives each withdrawal its own Tron transaction (see Each Withdrawal Names Its Own Transaction):

```compact
export circuit startTronWithdraw(
  inIndex: Uint<64>,
  withdrawRequest: TronWithdrawRequest,
  tronTx: TronTxWindow,
  coin: ShieldedCoinInfo
): [] {
  // ...the request checks, the coin check and takeFee...
  const commitment = ownershipCommitment(inIndex, callerSecretKey());
  const args = disclose(TronWithdrawArgs {
    request: withdrawRequest,
    tx: TronTxFields {
      refBlockBytes: tronTx.refBlockBytes,
      refBlockHash: tronTx.refBlockHash,
      timestamp: tronTx.timestamp,
      expiration: tronTx.expiration,
      feeLimit: vaultTronFeeLimit,
    },
    fee: fee,
    binding: commitment,
  });
  // ...the admission checks, then queue the request...
}
```

The reference block must be on the chain and recent. A transaction naming a block the chain does not hold is signed but can never land. To attest that a transaction never landed, the MPC takes the first block at or past the expiration and looks for the reference block at most 28,800 blocks below it, 24 hours of 3-second slots. While it cannot find the block there, it attests nothing. A client therefore builds the window on Tron's solidified head, the latest block that can no longer be reverted (`getSolidifiedTronReferenceBlock` in `@sig-net/midnight`), and keeps the expiration well under 24 hours past it.

## Refusing What the MPC Would Drop

The MPC judges a Tron request at the block of the Midnight transaction that notifies it. It drops a request it cannot encode, and it drops one whose validity window it does not admit: it admits a window only when the expiration is still ahead of that block's time and at most 24 hours past it, the cap of java-tron, Tron's node software. The MPC answers a dropped request with neither a signature nor an attestation, so nothing can settle it. The vault therefore runs the same admission checks itself, from the Signet module that ships in `@sig-net/midnight`, and refuses such a request on Midnight, where a refused start burns nothing.

The start runs `assertTronTriggerSmartContractTxParamsV1`, which asserts that every numeric field fits its signed 64-bit field and that the expiration follows the timestamp, then the window check with a margin that leaves room for the flush and the send. The send runs the window check again with a smaller margin, which leaves room for the gap between the block time the ledger checks and the one the MPC reads. Both keep the expiration a further margin inside the 24-hour cap:

```compact
export pure circuit tronWithdrawStartMinRemainingSeconds(): Uint<64> {
  return 600;
}

export pure circuit tronWithdrawSendMinRemainingSeconds(): Uint<64> {
  return 60;
}

export pure circuit tronWithdrawCapMarginSeconds(): Uint<64> {
  return 60;
}

// floor(millis / 1000), which assertTronExpirationWindowV1 checks: Compact cannot divide.
witness secondsOfMillis(millis: Uint<64>): Uint<64>;

circuit assertTronWithdrawWindow(expiration: Uint<64>, minRemainingSeconds: Uint<64>): [] {
  assertTronExpirationWindowV1(
    expiration,
    secondsOfMillis(expiration),
    minRemainingSeconds,
    tronWithdrawCapMarginSeconds()
  );
}
```

With `h` the expiration in whole seconds, a start is admitted while the block time is below `h - 600` and at least `h + 1 + 60 - 86400`, 86,400 seconds being the 24-hour cap, and a send while the block time is below `h - 60`, under the same cap. The MPC reads the block time in whole seconds, and so does the ledger, so the comparison is in whole seconds: the witness supplies the expiration's seconds and `assertTronExpirationWindowV1` asserts them against the milliseconds. Both checks hold at the block that includes the call, not when it is proved, so a client leaves room for proving and inclusion, and a start that lands too late fails with nothing burned.

## No Nonce, No Replacement

A Tron withdrawal's buffer entry carries `useNextVaultAccountNonce: false` and an `evmNonce` of 0, so the flush leaves `vaultAccountNonce` alone. The flush records `tronLastSeen` as the request's `lastSeen`, as it already does for a Tron deposit, so every attestation settling the withdrawal must come from a Tron block strictly above it. It is the Tron height that counts, since Tron and EVM heights advance independently.

There is nothing to replace either. `startReplaceNonce` reads the nonce of the request it replaces, and that read refuses a Tron withdrawal:

```compact
circuit sentVaultNonce(requestId: RequestId, action: Action): Uint<64> {
  assert(action != Action.deposit && action != Action.tronDeposit, "Deposit has no vault nonce");
  assert(action != Action.tronWithdraw, "Tron request has no vault nonce");
  // ...read the nonce from the action's event map...
}
```

A transaction that never lands simply expires. Once Tron's solidified head reaches the expiration, the MPC walks the blocks from the reference block to the first one at or past the expiration, and when the transaction is in none of them it attests the request unviable at that boundary block. The walk reaches 28,800 blocks back, which is why the reference block must be recent. `completeTronWithdraw` then refunds the amount. If the walk finds the transaction after all, the MPC waits for its receipt instead.

The fee is kept on this verdict too. Proposal 001 keeps it on unviable, where unviable only follows the deployer replacing a nonce. On Tron, unviable is the ordinary end of a withdrawal whose transaction never lands while the MPC can find its reference block, and the withdrawer pays the fee for it all the same.

## Each Withdrawal Names Its Own Transaction

A start is public: its arguments are disclosed into `tronWithdrawArgsMap`. Without a nonce, the transfer's fields alone would name the Tron transaction, so anyone could copy someone else's start (the same token, amount, destination and window) under a coin of their own. The copy would share the original's request index, so whichever came second could not be flushed until the first settled ("Identical request open"), and it would share the original's request id and Tron transaction, so the copy could keep the original from being flushed or, once the copy has settled, leave it with nothing to settle against.

Each transfer therefore carries one more calldata word after its ABI arguments, `binding`, the request's ownership commitment `ownershipCommitment(inIndex, callerSecretKey())`. It differs per requester and per input index, and it is the same value the request's buffer entry already publishes for the complete circuit to check, so the word discloses nothing new. The token's ABI decoder reads its two arguments and ignores the third:

```compact
circuit tronWithdrawEvent(
  args: TronWithdrawArgs
): SignBidirectionalEventV1<TronTriggerSmartContractTxParams<3>, 34, 0> {
  const calldata = EvmCalldata<3> {
    selector: Bytes [0xa9, 0x05, 0x9c, 0xbb], // transfer(address,uint256)
    noWords: 3 as Uint<16>,
    words: [
      evmAddressAbiWord(args.request.destTronAddress),
      numericAbiWord(args.request.amount),
      args.binding,
    ]
  };
  // ...the transaction fields and the event...
}
```

The binding is part of `TronWithdrawArgs`, so it changes the args hash and with it the request index, and it is part of the calldata, so it changes the request id and the Tron transaction. A copy now names its own transaction: the copy and the original flush, send and settle independently, and a copy that fails and is refunded leaves the original to settle on its own.

> **Note:** the alternative of a ledger set of every request id the vault has sent was dropped. It would refuse any repeat outright, a client's own included, but it is storage that only grows, by one entry per withdrawal for the life of the vault, where the binding word separates one requester from another with no state at all. The vault keeps no record of used request ids, and the one case the set alone would cover, a client repeating its own fields, is left to the client (see Residual Risk).

## Refund of a Withdrawal Nobody Sent

The Ethereum withdraw has no counterpart to this case, since its send has no deadline. The Tron start burns the coin, but the send is refused once the window is too close to closing, and a refused send writes nothing. A withdrawal nobody sent in time would therefore stay queued or flushed with its coin burned and no MPC request to settle it. `sendTronWithdraw` is permissionless, so anyone may send in time, but nobody is obliged to.

`refundUnsentTronWithdraw` closes that gap. From the first block time at which the send refuses the withdrawal, `h - 60` in whole seconds, the withdrawer can call it with the withdrawal's input index. It removes the withdrawal from whichever request buffer holds it and from `tronWithdrawArgsMap`, so no flush or send can reach it again, then re-mints the amount. The fee is kept, as a failed withdrawal keeps it:

```compact
export circuit refundUnsentTronWithdraw(inIndex: Uint<64>, mintNonce: Bytes<32>): [] {
  requireInitialised();
  const disclosedIndex = disclose(inIndex);
  assert(tronWithdrawArgsMap.member(disclosedIndex), "Tron withdrawal not open");
  const args = tronWithdrawArgsMap.lookup(disclosedIndex);
  const requestId = calculateTronTriggerSmartContractRequestIdV1<3, 34>(tronWithdrawEvent(args));
  assert(!bidirectionalTronWithdrawMap.member(requestId), "Request already sent");
  assertTronWithdrawSendClosed(args.tx.expiration);
  // ...find the queued or flushed entry, prove the requester, remove it, re-mint the amount...
}
```

A send and a refund of one withdrawal exclude each other through the ledger: the send needs the flushed entry the refund removes, and the refund needs the request id the send records to be absent. The refund is gated by the same ownership commitment the complete circuit proves, it runs once, and it adds no ledger field. A flushed entry no longer sits under its input index, which another action's request may hold by then, so the refund finds it under its request index. That index is derived from the args hash and the nonce, which is always 0 on Tron.

## Settling the Withdraw

`completeTronWithdraw` settles every verdict and, like `completeWithdraw`, can be called only by the withdrawer. On an executed verdict it checks the output against the attestation, and a transfer that returned `true` moved the tokens, so the burn stands. A `false` return moved nothing and is refunded, with one exception: Tron USDT returns `false` on a successful transfer, so a `false` from the token at `tronUsdtAddress` keeps the burn. A failed or unviable transaction is refunded:

```compact
export circuit completeTronWithdraw(
  requestId: RequestId,
  serializedOutput: Bytes<1>,
  mintNonce: Bytes<32>,
): [] {
  // ...settle the request, remove its args and event, and check an executed output against the attestation...
  const transferred = deserialize<VaultResponse, 1>(executed ? output : default<Bytes<1>>).success;
  if (
    outcomeRefunds(record.outputKind) ||
      (!transferred && args.request.tokenAddress != tronUsdtAddress)
  ) {
    mintShieldedToken(
      vaultTronTokenDomainSeparator(args.request.tokenAddress),
      args.request.amount as Uint<64>,
      disclose(mintNonce),
      left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey())
    );
  }
}
```

The refund re-mints `args.request.amount` and never the fee. A transfer that runs out of energy fails on Tron and is refunded, and the TRX it burned stays burned.

## How the Coins Flow

The withdrawal leaves the request buffers by at most one of two exits: an attestation settled by `completeTronWithdraw`, or, if it was never sent, `refundUnsentTronWithdraw`. A sent withdrawal that is never attested takes neither (see Residual Risk). Below, `h` is the expiration in whole seconds. The start and send labels give the block time each call must stay below, and the refund label gives the block time from which it opens. The 24-hour cap applies to the start and the send as well, and every refund keeps the fee.

```text
withdrawer's wallet     contract                              MPC                       Tron
───────────────────     ────────                              ───                       ────

{ color, nonce0, amount + fee }
        │
        │  startTronWithdraw(inIndex, withdrawRequest, tronTx, coin), block time < h - 600:
        │  burns the coin, mints any fee to the fee recipient, and stores the window,
        │  vaultTronFeeLimit and the binding in tronWithdrawArgsMap
        ▼
                        inputRequestBuffer[inIndex]
                                │
                                │  flushQueue (anyone): lastSeen = tronLastSeen
                                ▼
                        outputRequestBuffer[requestIndex]
                                │
                                │  sendTronWithdraw (anyone), block time < h - 60:
                                │  records the request in bidirectionalTronWithdrawMap
                                │  and notifies the MPC
                                └──────────────────────────▶  admits, signs
        ┌───────────────────────────────────────────────────  signature
        │  the client broadcasts the signed transaction
        └────────────────────────────────────────────────────────────────────────────▶  transfer(destTronAddress,
                                                                                          amount, binding)
                                                              executed, failed  ◀─────  lands, reverts,
                                                              or unviable               or expires unseen
                                ┌───────────────────────────  attestation
                                │  queueAttestation, flushQueue (anyone)
                                ▼
                        completeTronWithdraw (the withdrawer)
true, or false from
tronUsdtAddress         the burn stands
anything else       ◀── { color, mintNonce, amount }

                        refundUnsentTronWithdraw (the withdrawer), block time >= h - 60
never sent          ◀── { color, mintNonce, amount }
```

## How Clients and Operators Deal With It

A client picks a fresh random input index for every withdrawal, since the index feeds the binding, and builds the window on the solidified head: the example flow takes the current time as the `timestamp` and asks for an hour by default. After the start it reads back the window, fee limit and binding the vault stored and computes from them the request id the send will record. The example round trip then polls the Sig Network Responder Contract, where the MPC posts its signature over the request the vault recorded, broadcasts the signed transaction to Tron itself, waits for the attestation and settles it, with a random `mintNonce` on the complete as for the Ethereum withdraw. A client whose withdrawal was not sent in time waits for the refund to open at `h - 60` seconds and calls `refundUnsentTronWithdraw`, again with a random `mintNonce`.

The operator funds the vault's Tron account, `tronAddress(vaultEvmAddress)`, with TRX for the network to burn for energy and bandwidth, or stakes TRX so transfers burn none, and sets `vaultTronFeeLimit` above the worst energy price of one TRC-20 transfer. A TRC-20 is listed with `addAllowedTronToken`, which writes over an existing entry, so calling it again is how its fees are repriced. The operator lists only TRC-20s that accept trailing calldata, as Tron USDT does, and lists USDT only in a vault initialised with its address: `initialise()` sets `tronUsdtAddress` once and no circuit changes it.

## Residual Risk

The fee carries proposal 001's residual risk unchanged, with the prices of TRX and of energy in place of ETH's price and gas. The fee is a fixed amount of the TRC-20, while what the vault spends is energy and bandwidth, paid from staked resources or by burning TRX, with each transfer's energy capped by the fee limit its request stored at start, and a transfer that fails and is refunded still burns what it used. The operator's duty to reprice is the same, through `addAllowedTronToken`.

A TRC-20 whose ABI decoder refused trailing calldata would fail every withdrawal. Each failure is refunded with the fee kept, so that token's deposits could never leave the vault. The contract cannot tell such a token apart, so only the listing decision protects against it.

The vault keeps no record of used fields. A client that repeats an earlier withdrawal's input index, window, token, amount, destination and fee limit under the same key gets the same Tron transaction, which Tron takes only once, and that withdrawal's coin can be left with nothing to settle it. The binding protects one requester from another, not a client from itself: only a fresh input index does that.

Once sent, a withdrawal settles only through an attestation, since the refund refuses a request id the send recorded. A transaction naming a reference block the chain does not hold is signed but never lands and is never attested, so its coin stays burned. The coin of a transaction that never lands also stays burned when its reference block lies beyond the 28,800 blocks the MPC walks, which a window close to 24 hours can cause. The contract checks the window but cannot check the reference block. The same holds for a sent request the MPC drops anyway: the window checks follow the MPC's admission rule as the Signet module states it, with a 60-second margin on each side at the send, and those margins are the vault's only protection against a gap between the two block times.

`initialise()` sets `tronUsdtAddress` once. In a vault initialised with any other address, every executed USDT withdrawal returns `false` and is refunded although the tokens left, so the withdrawer keeps both the USDT on Tron and the re-minted vault coin.

The fee is kept on an unviable verdict (see No Nonce, No Replacement), whatever kept the transaction off the chain. Refunding it there would need the architecture proposal 001 mentions, where the fee is held back until the request settles.
