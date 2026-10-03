# Image fixing todos

The erc20-vault diagrams below do not match the contract's request queue.
Each entry names the `.drawio` source and its rendered `.png`, quotes every
stale label as it appears in the diagram, and says what it becomes according
to `examples/erc20-vault/contract/src/erc20-vault.compact` and the flows in
`examples/erc20-vault/integration-tests/src/flows/`. Edit the `.drawio`, then
re-render its `.png` under [docs/diagramming.md](docs/diagramming.md): the
pair moves together.

Two points apply to every flow diagram:

- **Step circles.** The flow pages now number every Midnight transaction of
  the queue pattern (start, flush the request, send, queue the attestation,
  flush the attestation, complete), so each diagram needs one numbered circle
  per step of its page and no branch arms at the settle step. The phase
  palette in `docs/diagramming.md` names no phase for a flush or a queued
  attestation: choose one for steps "flushQueue(...) moves the request into
  the output buffer", "queue the attestation at its output's width" and
  "flushQueue(...) moves the attestation into the output buffer", and record
  the choice in `docs/diagramming.md` in the same change.
- **Contract box membership.** Each flow's box holds exactly the ledger
  fields and circuits its circuits touch, as listed per entry below (derived
  from the contract source: every field named in the flow's start, send,
  queue, complete and `flushQueue` circuits and the helpers they call).
  `signetSigner` is sealed, so it stays off every box.

## Actor map

- Source: `examples/erc20-vault/docs/actor-map.drawio`
- Render: `examples/erc20-vault/docs/actor-map.drawio.png`

The actor map must carry every exported circuit, the witness and every
exported ledger field.

Ledger rows:

- Delete `ledger signBidirectionalEventMap { RequestId: SignBidirectionalEvent }`:
  no such field exists.
- Delete `ledger signetRequestNonce`: no such field exists.
- Rename `ledger depositEventMap { RequestId: SignBidirectionalEvent }` to
  `ledger bidirectionalDepositMap { RequestId: SignBidirectionalEvent }`, and
  likewise `ledger swapEventMap` to `bidirectionalSwapMap`,
  `ledger supplyEventMap` to `bidirectionalSupplyMap` and
  `ledger redeemEventMap` to `bidirectionalRedeemMap`.
- Add `ledger bidirectionalWithdrawMap`, `ledger bidirectionalApproveMap` and
  `ledger bidirectionalReplaceNonceMap`, each `{ RequestId: SignBidirectionalEvent }`.
- Delete the five settle-view rows: `ledger withdrawSettleViews { RequestId: WithdrawSettleView }`,
  `ledger depositSettleViews { RequestId: DepositSettleView }`,
  `ledger swapSettleViews { RequestId: SwapSettleView }`,
  `ledger supplySettleViews { RequestId: SupplySettleView }` and
  `ledger redeemSettleViews { RequestId: RedeemSettleView }`.
- Add the seven args maps, each `{ Uint<64>: <Action>Args }`:
  `depositArgsMap` (`DepositArgs`), `withdrawArgsMap` (`WithdrawArgs`),
  `approveArgsMap` (`ApproveArgs`), `replaceNonceArgsMap` (`ReplaceNonceArgs`),
  `swapArgsMap` (`SwapArgs`), `supplyArgsMap` (`SupplyArgs`) and
  `redeemArgsMap` (`RedeemArgs`).
- Add the request queue: `ledger globalLastSeen`, `ledger vaultAccountNonce`,
  `ledger inputRequestBuffer { Uint<64>: RequestBufferEntry }`,
  `ledger outputRequestBuffer { Bytes<32>: OutputRequestEntry }`,
  `ledger inputAttestationBuffer { RequestId: AttestationRecord }`,
  `ledger outputAttestationBuffer { RequestId: AttestationRecord }` and
  `ledger evictionMap { RequestId: Bytes<32> }`.
- Add the configuration fields the map lacks: `ledger mpcKeyVersion`,
  `ledger vaultMaxFeePerGas`, `ledger vaultMaxPriorityFeePerGas` and
  `ledger vaultGasLimits`.
- Keep `ledger mpcResponseKey`, `ledger vaultEvmAddress`, `ledger initialised`,
  `ledger evmChainId`, `ledger uniswapRouter`, `ledger stataUnderlying` and
  `ledger stataToken`. The result is the 32 exported fields of the compiled
  `contract-info.json` (34 fields less the sealed `signetSigner` and
  `deployer`).

Circuit rows (28 exported provable circuits, pure circuits omitted):

- Rename `circuit approveRouter(...)` to `circuit startApproveRouter(...)` and
  `circuit approveStata(...)` to `circuit startApproveStata(...)`.
- Delete `circuit refundWithdraw(...)`, `circuit refundSwap(...)`,
  `circuit refundSupply(...)` and `circuit refundRedeem(...)`: every complete
  circuit settles every verdict.
- Add `circuit setGasParams(...)`, `circuit flushQueue(...)`,
  `circuit queueAttestation0(...)`, `circuit queueAttestation1(...)`,
  `circuit queueAttestation8(...)`, `circuit sendDeposit(...)`,
  `circuit sendWithdraw(...)`, `circuit sendApprove(...)`,
  `circuit completeApprove(...)`, `circuit startReplaceNonce(...)`,
  `circuit sendReplaceNonce(...)`, `circuit completeReplaceNonce(...)`,
  `circuit sendSwap(...)`, `circuit sendSupply(...)` and `circuit sendRedeem(...)`.
- Keep `circuit initialise(...)`, `circuit startDeposit(...)`,
  `circuit completeDeposit(...)`, `circuit startWithdraw(...)`,
  `circuit completeWithdraw(...)`, `circuit startSwap(...)`,
  `circuit completeSwap(...)`, `circuit startSupply(...)`,
  `circuit completeSupply(...)`, `circuit startRedeem(...)`,
  `circuit completeRedeem(...)` and `witness callerSecretKey(...)`.

MPC lane:

- The `n-read` note reads "Reads: the recorded request From:
  signBidirectionalEventMap depositEventMap swapEventMap supplyEventMap
  redeemEventMap". It becomes the seven event maps: `bidirectionalReplaceNonceMap`,
  `bidirectionalApproveMap`, `bidirectionalDepositMap`,
  `bidirectionalWithdrawMap`, `bidirectionalSwapMap`,
  `bidirectionalSupplyMap` and `bidirectionalRedeemMap`.

Size: the added rows grow the map past the 1825 x 1648 that
`docs/diagramming.md` sanctions for it, so update that figure in the same
change.

## Deposit flow

- Source: `examples/erc20-vault/docs/deposit/deposit.drawio`
- Render: `examples/erc20-vault/docs/deposit/deposit.drawio.png`
- Page: `examples/erc20-vault/docs/deposit/deposit.md` (10 steps)

Contract box:

- Delete `ledger signetRequestNonce`.
- Rename `ledger depositEventMap { RequestId: SignBidirectionalEvent }` to
  `ledger bidirectionalDepositMap { RequestId: SignBidirectionalEvent }`.
- Replace `ledger depositSettleViews { RequestId: DepositSettleView }` with
  `ledger depositArgsMap { Uint<64>: DepositArgs }`.
- Add `ledger globalLastSeen`, `ledger mpcKeyVersion`, the four buffers
  (`inputRequestBuffer`, `outputRequestBuffer`, `inputAttestationBuffer`,
  `outputAttestationBuffer`) and `ledger evictionMap`. `flushQueue` also names
  `vaultAccountNonce`, but reads it only for a vault-signed entry, never for a
  deposit: leave it off unless the membership rule is read to include it.
- Keep `ledger initialised`, `ledger evmChainId`, `ledger mpcResponseKey` and
  `ledger vaultEvmAddress`.
- Add `circuit flushQueue(...)`, `circuit sendDeposit(...)`,
  `circuit queueAttestation1(...)` and `circuit queueAttestation0(...)`.
- The `n-read` note "From: depositEventMap" becomes
  "From: bidirectionalDepositMap".

Steps and edges (the page's 10 steps):

- The circles `1.` to `6.` become `1.` to `10.`.
- Edge `e1b` "startDeposit circuit: Calls the singleton to notify the MPC"
  leaves `circuit startDeposit(...)`, but the start notifies nothing: the
  edge moves to step 4 and reads "sendDeposit circuit: Calls the singleton to
  notify the MPC", from `circuit sendDeposit(...)` to
  `circuit signBidirectional(...)`.
- Edge `e1a` "User's Midnight wallet: Starts startDeposit(...) with the ERC20
  address and amount" stays, as step 2.
- New edges from the Midnight wallet: step 3 to `circuit flushQueue(...)`,
  step 4 to `circuit sendDeposit(...)`, step 8 to the queue circuits and
  step 9 to `circuit flushQueue(...)`, each with an acting-party label.
- Edge `e2b` "MPC: Reads the recorded request" retargets to the
  `bidirectionalDepositMap` row.
- Edge `e5` "User's Midnight wallet: Submits the attested event and output to
  completeDeposit(...)" is stale: the attested event now goes to the queue
  circuit in step 8, and `completeDeposit(...)` (step 10) takes the request
  id, the output, a mint nonce and an optional recipient.

## Withdraw flow

- Source: `examples/erc20-vault/docs/withdraw/withdraw.drawio`
- Render: `examples/erc20-vault/docs/withdraw/withdraw.drawio.png`
- Page: `examples/erc20-vault/docs/withdraw/withdraw.md` (9 steps)

Contract box:

- Replace `ledger signBidirectionalEventMap { RequestId: SignBidirectionalEvent }`
  with `ledger bidirectionalWithdrawMap { RequestId: SignBidirectionalEvent }`.
- Delete `ledger signetRequestNonce` and
  `ledger withdrawSettleViews { RequestId: WithdrawSettleView }`.
- Add `ledger withdrawArgsMap { Uint<64>: WithdrawArgs }`,
  `ledger globalLastSeen`, `ledger vaultAccountNonce`, `ledger mpcKeyVersion`,
  `ledger vaultGasLimits`, `ledger vaultMaxFeePerGas`,
  `ledger vaultMaxPriorityFeePerGas`, the four buffers and
  `ledger evictionMap`.
- `ledger vaultEvmAddress` is read by no withdraw circuit (the transfer is
  signed under the path `"vault"` and pays `destEvmAddress`): the membership
  rule drops the row unless the derivation edge from the `"vault"`
  `keyDerivation(...)` note keeps it.
- Delete `circuit refundWithdraw(...)`. Add `circuit flushQueue(...)`,
  `circuit sendWithdraw(...)`, `circuit queueAttestation1(...)` and
  `circuit queueAttestation0(...)`.
- The `n-read` note "From: signBidirectionalEventMap" becomes
  "From: bidirectionalWithdrawMap".

Steps and edges:

- The circles `1.` to `4.` plus the two step-5 arms `c5a` and `c5b` become
  `1.` to `9.` with no arms.
- Edge `e1b` "startWithdraw circuit: Calls signBidirectional(...)" becomes
  "sendWithdraw circuit: Calls signBidirectional(...)", from
  `circuit sendWithdraw(...)`, as step 3.
- Delete edge `e5b` "User's Midnight wallet: Submits refundWithdraw(...) when
  the transfer never executed".
- Edge `e5a` "User's Midnight wallet: Submits completeWithdraw(...)" becomes
  step 9.
- New wallet edges for step 2 (`flushQueue(...)`), step 3
  (`sendWithdraw(...)`), step 7 (the queue circuits) and step 8
  (`flushQueue(...)`).
- Edge `e2b` "MPC: Reads the recorded request" retargets to the
  `bidirectionalWithdrawMap` row.

## Swap flow

- Source: `examples/erc20-vault/docs/swap/swap.drawio`
- Render: `examples/erc20-vault/docs/swap/swap.drawio.png`
- Page: `examples/erc20-vault/docs/swap/swap.md` (9 steps)

Contract box:

- Delete `ledger signBidirectionalEventMap { RequestId: SignBidirectionalEvent }`
  and `ledger signetRequestNonce`.
- Rename `ledger swapEventMap { RequestId: SignBidirectionalEvent }` to
  `ledger bidirectionalSwapMap { RequestId: SignBidirectionalEvent }`.
- Replace `ledger swapSettleViews { RequestId: SwapSettleView }` with
  `ledger swapArgsMap { Uint<64>: SwapArgs }`.
- Add `ledger globalLastSeen`, `ledger vaultAccountNonce`,
  `ledger mpcKeyVersion`, `ledger vaultGasLimits`,
  `ledger vaultMaxFeePerGas`, `ledger vaultMaxPriorityFeePerGas`, the four
  buffers and `ledger evictionMap`. Keep `ledger uniswapRouter`,
  `ledger vaultEvmAddress`, `ledger initialised`, `ledger evmChainId` and
  `ledger mpcResponseKey`.
- Delete `circuit approveRouter(...)` and `circuit refundSwap(...)`. Add
  `circuit flushQueue(...)`, `circuit sendSwap(...)`,
  `circuit queueAttestation8(...)` and `circuit queueAttestation0(...)`.
- The `n-read` note "From: signBidirectionalEventMap swapEventMap" becomes
  "From: bidirectionalSwapMap".

Steps and edges:

- Delete the approval step: circle `1.` with edges `a1a` "User's Midnight
  wallet: Starts approveRouter(...) once per token" and `a1b`
  "approve(uniswapRouter, unlimitedAllowance)". The router approval is a
  deployer-gated request of its own (`startApproveRouter(...)`), outside
  this flow.
- The circles `2.` to `5.` plus the two step-6 arms `c6a` and `c6b` become
  `1.` to `9.` with no arms.
- Edge `e1b` "startSwap circuit: Calls signBidirectional(...)" becomes
  "sendSwap circuit: Calls signBidirectional(...)", from
  `circuit sendSwap(...)`, as step 3.
- Delete edge `e5b` "User's Midnight wallet: Submits refundSwap(...) when the
  swap never executed". Edge `e5a` "User's Midnight wallet: Submits
  completeSwap(...) when the swap executed" becomes step 9 and drops "when the
  swap executed": `completeSwap(...)` settles every verdict.
- New wallet edges for steps 2, 3, 7 and 8, as for the withdraw flow.
- Edge `e2b` "MPC: Reads the recorded swap request" retargets to the
  `bidirectionalSwapMap` row.

## Supply flow

- Source: `examples/erc20-vault/docs/supply/supply.drawio`
- Render: `examples/erc20-vault/docs/supply/supply.drawio.png`
- Page: `examples/erc20-vault/docs/supply/supply.md` (9 steps)

Contract box:

- Delete `ledger signBidirectionalEventMap { RequestId: SignBidirectionalEvent }`
  and `ledger signetRequestNonce`.
- Rename `ledger supplyEventMap { RequestId: SignBidirectionalEvent }` to
  `ledger bidirectionalSupplyMap { RequestId: SignBidirectionalEvent }`.
- Replace `ledger supplySettleViews { RequestId: SupplySettleView }` with
  `ledger supplyArgsMap { Uint<64>: SupplyArgs }`.
- Add `ledger globalLastSeen`, `ledger vaultAccountNonce`,
  `ledger mpcKeyVersion`, `ledger vaultGasLimits`,
  `ledger vaultMaxFeePerGas`, `ledger vaultMaxPriorityFeePerGas`, the four
  buffers and `ledger evictionMap`. Keep `ledger stataUnderlying`,
  `ledger stataToken`, `ledger vaultEvmAddress`, `ledger initialised`,
  `ledger evmChainId` and `ledger mpcResponseKey`.
- Delete `circuit approveStata(...)` and `circuit refundSupply(...)`. Add
  `circuit flushQueue(...)`, `circuit sendSupply(...)`,
  `circuit queueAttestation8(...)` and `circuit queueAttestation0(...)`.
- The `n-read` note "From: signBidirectionalEventMap supplyEventMap" becomes
  "From: bidirectionalSupplyMap".

Steps and edges:

- Delete the approval step: circle `1.` with edges `a1a` "User's Midnight
  wallet: Starts approveStata(...) once for the wrapper" and `a1b`
  "approve(stataToken, unlimitedAllowance)". The stata approval is a
  deployer-gated request of its own (`startApproveStata(...)`), outside this
  flow.
- The circles `2.` to `5.` plus the two step-6 arms become `1.` to `9.` with
  no arms.
- Edge `e1b` "startSupply circuit: Calls signBidirectional(...)" becomes
  "sendSupply circuit: Calls signBidirectional(...)", from
  `circuit sendSupply(...)`, as step 3.
- The code label `e3b` "deposit(amount, vault)" becomes
  "deposit(amount, vaultEvmAddress)", the calldata `sendSupply` builds.
- Delete edge `e5b` "User's Midnight wallet: Submits refundSupply(...) when
  the supply never executed". Edge `e5a` "User's Midnight wallet: Submits
  completeSupply(...) when the supply executed" becomes step 9 and drops
  "when the supply executed".
- New wallet edges for steps 2, 3, 7 and 8, as for the withdraw flow.
- Edge `e2b` "MPC: Reads the recorded supply request" retargets to the
  `bidirectionalSupplyMap` row.

## Redeem flow

- Source: `examples/erc20-vault/docs/redeem/redeem.drawio`
- Render: `examples/erc20-vault/docs/redeem/redeem.drawio.png`
- Page: `examples/erc20-vault/docs/redeem/redeem.md` (9 steps)

Contract box:

- Delete `ledger signetRequestNonce`.
- Rename `ledger redeemEventMap { RequestId: SignBidirectionalEvent }` to
  `ledger bidirectionalRedeemMap { RequestId: SignBidirectionalEvent }`.
- Replace `ledger redeemSettleViews { RequestId: RedeemSettleView }` with
  `ledger redeemArgsMap { Uint<64>: RedeemArgs }`.
- Add `ledger globalLastSeen`, `ledger vaultAccountNonce`,
  `ledger mpcKeyVersion`, `ledger vaultGasLimits`,
  `ledger vaultMaxFeePerGas`, `ledger vaultMaxPriorityFeePerGas`, the four
  buffers and `ledger evictionMap`. Keep `ledger stataUnderlying`,
  `ledger stataToken`, `ledger vaultEvmAddress`, `ledger initialised`,
  `ledger evmChainId` and `ledger mpcResponseKey`.
- Delete `circuit refundRedeem(...)`. Add `circuit flushQueue(...)`,
  `circuit sendRedeem(...)`, `circuit queueAttestation8(...)` and
  `circuit queueAttestation0(...)`.
- The `n-read` note "From: redeemEventMap" becomes
  "From: bidirectionalRedeemMap".

Steps and edges:

- The circles `1.` to `4.` plus the two step-5 arms `c5a` and `c5b` become
  `1.` to `9.` with no arms.
- Edge `e1b` "startRedeem circuit: Calls signBidirectional(...)" becomes
  "sendRedeem circuit: Calls signBidirectional(...)", from
  `circuit sendRedeem(...)`, as step 3.
- The code label `e3b` "redeem(shares, vault, vault)" becomes
  "redeem(shares, vaultEvmAddress, vaultEvmAddress)", the calldata
  `sendRedeem` builds.
- Delete edge `e5b` "User's Midnight wallet: Submits refundRedeem(...) when
  the redeem never executed". Edge `e5a` "User's Midnight wallet: Submits
  completeRedeem(...) when the redeem executed" becomes step 9 and drops
  "when the redeem executed".
- New wallet edges for steps 2, 3, 7 and 8, as for the withdraw flow.
- Edge `e2b` "MPC: Reads the recorded redeem request" retargets to the
  `bidirectionalRedeemMap` row.

## Checked, current

- `docs/sign-bidirectional-flow.drawio` and `.drawio.png`: the generic
  protocol diagram, whose hypothetical integrating contract carries no vault
  names.
- `docs/diagram-palette.drawio` and `.drawio.png`: the style copy source,
  generic.
