# Deposit

The deposit round trip moves ERC20 tokens from the user's derived EVM deposit
address into the vault's own EVM account, and mints the user's balance on
Midnight once the MPC has attested the transfer. It is one full pass through the
sign bidirectional flow: two Midnight transactions (`deposit(...)`, `claim(...)`)
bracketing one MPC-signed EVM transaction.

## The protocol

It is best to understand the
[sign bidirectional flow](../../../../README.md#sign-bidirectional-protocol-flow) before
you continue here. For more detail see the
[sign bidirectional flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-flow)
in the midnight integration repository.

## The integration

To wire this shape into a contract of your own, start from the
[Integration guide](../../../../README.md#integration-guide) in the repo README.
For the full walkthrough see the
[Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide)
in the midnight integration repository.

## The deposit round trip

The round trip runs from the user funding their derived deposit account on the
EVM chain to the vault minting their shielded balance on Midnight. The first
step is the user's own EVM wallet acting alone, before any contract is
involved. The user's wallet then drives the two Midnight transactions, the Vault
dApp (Relayer) does the polling and the broadcast, and the MPC reads, signs and
attests.

![Deposit flow](deposit.drawio.png)

As illustrated, the flow comprises 6 steps:

- **1.** fund the user's deposit account
  - The user transfers the ERC20 being deposited plus gas ETH from their own EVM
    wallet into their **deposit account**, an EVM address the MPC derives for
    the vault contract from the caller's 32-byte identity commitment (see
    [Derived keys and accounts](../../README.md#derived-keys-and-accounts)). No
    vault circuit, no MPC and no relayer take part: it is an ordinary EVM
    transaction.
  - Every later step assumes the deposit account already holds the tokens to
    sweep and the ETH to pay its own gas. On the local fork the setup pipeline
    deals both to it
    ([`dealForkEvmAccounts`](../../integration-tests/src/fork-funding.ts#L154)),
    and on a real chain the user funds the printed
    `EVM_USER1_DEPOSIT_ADDRESS`.
- **2.** deposit(...) records the request
  - The user calls
    [`deposit(...)`](../../contract/src/erc20-vault.compact#L367) with the ERC20
    address and a private amount. The circuit composes the ENTIRE EVM sweep
    transaction itself: the calldata is `transfer(vaultEvmAddress, amount)`
    built in-circuit around the initialize-pinned
    [`vaultEvmAddress`](../../contract/src/erc20-vault.compact#L91), which is
    what stops a malicious client having the MPC sign a transfer to themselves.
  - The request's **derivation path** is not an argument either: the circuit
    recomputes the caller's commitment from the
    [`callerSecretKey()`](../../contract/src/erc20-vault.compact#L284) witness
    with [`userCommitment`](../../contract/src/erc20-vault.compact#L288), so the
    MPC signs with THIS caller's deposit account and no one else's. The caller
    supplies only what is genuinely theirs to choose: their account's nonce, the
    gas envelope their account pays, and the MPC key version.
  - The assembled **SignBidirectionalEvent**
    ([`constructSignBidirectionalEvent`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/Signet.compact#L135))
    is stored in the ledger's
    [`signBidirectionalEventMap`](../../contract/src/erc20-vault.compact#L66)
    under its **request id**, the hash of the record itself, and the circuit
    then calls the singleton's
    [`signBidirectional`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-contract/src/signet-contract.compact#L31)
    to notify the MPC, carrying the map's resolved ledger-tree path.
  - Off-chain, [`deposit.ts`](../../integration-tests/src/flows/deposit.ts#L78)
    reconstructs that expected record byte for byte, hashes it with the
    library's
    [`calculateRequestId`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/signet-request-id.ts#L28)
    TypeScript twin, and asserts the recomputed id appears as a ledger map key.
    That id is what every later step keys on.
- **3.** poll for the MPC's signature
  - The MPC reads the recorded request from the vault's ledger, signs the sweep
    transaction with the user's derived deposit-account key, and posts the
    signature back through the singleton's
    [`respond`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-contract/src/signet-contract.compact#L52).
  - The dApp polls the singleton's emitted response events with
    [`poll-signature-response.ts`](../../integration-tests/src/flows/poll-signature-response.ts#L63).
    The event log is unauthenticated (anyone may post), so enumeration and
    verification go through the SDK's
    [`SignetRequestResponseReader`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/signet-request-response-reader.ts#L118),
    which judges every post by whether its signature recovers to the request's
    expected signer, the user's deposit account, over the requested
    transaction's signing hash. The first valid post wins.
  - The flow returns the reconstructed sweep as a typed ethers `Transaction`,
    serialised only at the broadcast edge.
- **4.** broadcast the sweep to the EVM chain
  - The MPC only signs, so broadcasting is the relayer's responsibility:
    [`broadcast-evm.ts`](../../integration-tests/src/flows/broadcast-evm.ts#L81)
    sends the signed transaction and waits for one confirmation. The sweep moves
    the ERC20 from the user's deposit account into the vault's own account.
  - The broadcast is idempotent. A signed EVM transaction's hash is a pure
    function of its bytes, so an already-mined sweep short-circuits and a node
    reporting the transaction as already submitted is tolerated. A reverted
    transaction, or one whose nonce a different transaction consumed, is
    surfaced as an error rather than hung on.
- **5.** poll for the MPC's attestation
  - The MPC watches the EVM chain for the transaction's execution and posts an
    attestation of its output through the singleton's
    [`respondBidirectional`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-contract/src/signet-contract.compact#L78).
    The emitted event carries the request id it answers and the MPC's ECDSA
    signature over the attestation digest
    `keccak256(requestId || serializedOutput)`, and nothing else: neither the
    digest nor the serialised output goes on chain.
  - The client must therefore rebuild the exact bytes the MPC hashed.
    [`respond-output.ts`](../../integration-tests/src/flows/respond-output.ts#L110)
    takes the mined call's raw EVM return data (the fakenet responder caches
    each traced output before it posts, and serves it at
    `/responses/{requestId}`, while a node with tracing enabled yields the same
    bytes from `debug_traceTransaction`, the RPC method the MPC itself uses),
    then decodes it per the request's output deserialisation schema with
    [`deserializeEvmOutput`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/abi-serde.ts#L143)
    and re-packs it per the respond serialisation schema with
    [`serializeRespondOutput`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/abi-serde.ts#L194):
    the exact two conversions the responder ran, the sweep's 32-byte ABI `bool`
    word in and its 1-byte packed result out.
  - Two candidates are checked, not one. The success candidate is the re-packed
    output above, and the failure candidate is the protocol's fixed 5-byte
    failure output
    [`MPC_FAILURE_OUTPUT`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/constants.ts#L29)
    (`0xdeadbeef01`), which the MPC attests when the transaction reverted or was
    replaced. Whichever candidate a posted signature verifies over, against the
    [`mpcResponseKey`](../../contract/src/erc20-vault.compact#L78) read from the
    vault's own ledger, is the attested outcome. The success candidate is
    skipped when no output was cached, and a decode failure drops it with a
    warning instead of crashing the poll.
  - [`poll-respond-bidirectional.ts`](../../integration-tests/src/flows/poll-respond-bidirectional.ts#L47)
    owns the loop, the timeout and the reporting. Everything resolved here stays
    UNTRUSTED: the respond events are open to anyone and the helper API is
    unauthenticated, and the authoritative check is the in-circuit verification
    step 6 runs.
- **6.** claim(...) verifies and mints
  - The user calls [`claim(...)`](../../contract/src/erc20-vault.compact#L460)
    with the request id, the attested event and the recomputed output bytes. The
    circuit re-hashes those bytes into the attestation digest and verifies the
    event's ECDSA signature over it against the initialize-pinned
    [`mpcResponseKey`](../../contract/src/erc20-vault.compact#L78) with
    [`verifyRespondBidirectionalEvent`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/Signet.compact#L327).
    The singleton emits MPC posts unverified, so this is the only authentication
    gate.
  - The one-byte output is deserialised into the schema's `VaultResponse` and
    its `success` flag asserted, so only an attested successful transfer mints.
    A sweep the MPC attested as failed cannot be claimed at all, and
    [`claim.ts`](../../integration-tests/src/flows/claim.ts#L69) refuses to call
    the circuit for one.
  - The stored request is looked up and removed from
    [`signBidirectionalEventMap`](../../contract/src/erc20-vault.compact#L66),
    which is the double-claim protection, and the caller's recomputed commitment
    must equal that request's path, which makes claims depositor-only.
  - The mint's amount and token colour come from the stored request itself,
    calldata word 1 and `txParams.to`, and the shielded vault tokens go to the
    caller or to an optional recipient's coin public key. The mint nonce is a
    fresh RANDOM 32 bytes per claim: one derived from the (public) request id
    would let any observer link the minted coin to the deposit. Minting to
    another wallet needs that wallet's encryption public key mapped in, which is
    why the flow wraps that case in a contract-scoped transaction.

## The shared vault and reader setup

Every circuit call goes through the deployed vault, joined once with the
caller's identity secret as private state: see
[Runtime: joining the deployed vault](../../README.md#runtime-joining-the-deployed-vault)
in the repo README. That secret is the user's own random value, named
`MIDNIGHT_USER1_VAULT_SECRET` in the diagrams and supplied to the integration
tests by the environment variable of that name.

The off-chain steps (3 to 5) share one `SignetRequestResponseReader` over the
vault and singleton pair, built by
[`createResponseReader`](../../integration-tests/src/vault-context.ts#L152). The
expected signer of the deposit sweep is the user's deposit account, derived with
[`deriveEvmAddress`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/epsilon-derivation.ts#L73)
from the caller's identity commitment rendered as full-width lowercase hex, the
MPC's rendering of every request's 32 opaque path bytes. The key `claim` verifies
against is derived with
[`deriveMidnightResponseKey`](https://github.com/sig-net/midnight-integration/blob/main/packages/signet-midnight/src/epsilon-derivation.ts#L144).
Those two functions are the concrete work behind the diagram's abstract
`keyDerivation(...)` notes, and the commitment itself is computed with the
vault's own compiled `userCommitment` circuit, never a TypeScript
re-implementation (see
[Derived keys and accounts](../../README.md#derived-keys-and-accounts)).

## Sequence

```mermaid
sequenceDiagram
    title Deposit round trip
    actor User
    participant DApp as Vault dApp (Relayer)
    participant Vault as ERC20 Vault Contract
    participant Singleton as Sig Network Singleton Contract
    participant MPC as Sig Network Distributed MPC
    participant EVM as EVM Blockchain

    Note over User,EVM: Step 1: fund the user's deposit account
    User->>EVM: funds the deposit account with the ERC20 being deposited plus gas ETH
    Note over User,Singleton: Step 2: deposit(...) records the request
    User->>Vault: deposit(...)
    Vault->>Singleton: signBidirectional(...)
    Note over DApp,MPC: Step 3: poll for the MPC's signature
    MPC->>Vault: reads the recorded request
    MPC->>Singleton: respond(...) posts the signature
    DApp->>Singleton: polls for the signature
    Note over DApp,EVM: Step 4: broadcast the sweep to the EVM chain
    DApp->>EVM: broadcasts the MPC-signed transfer(vaultEvmAddress, amount)
    Note over DApp,EVM: Step 5: poll for the MPC's attestation
    MPC->>EVM: watches for transaction execution
    MPC->>Singleton: respondBidirectional(...) posts the attestation
    DApp->>Singleton: polls for the attestation
    Note over User,Vault: Step 6: claim(...) verifies and mints
    User->>Vault: claim(...)
```

---

Next: [Withdraw](../withdraw/withdraw.md) · Up: [ERC20 Vault](../../README.md) · Protocol: [Sign Bidirectional Flow](../../../../README.md#sign-bidirectional-protocol-flow)
