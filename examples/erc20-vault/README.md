# ERC20 Vault

This example demonstrates bridging ERC20 assets from an EVM chain into shielded
tokens on Midnight, and back again, without a custodian. A Midnight contract
(the vault) owns an EVM account whose key nobody holds. The address is derived
from the Signature Network MPC's root public key, and every EVM transaction the
vault sends is signed by the MPC network on the vault's request via the
[sign-bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional).

> ## ⚠️ CAUTION ⚠️
>
> This example application is for educational and experimental purposes.
> Expect rapid iteration.
> **Use at your own risk.**

What this example demonstrates, end to end:

- A Compact contract requesting EVM transaction signatures from the Signature
  Network singleton contract with a cross-contract call on Midnight.
- The MPC observing the request, signing the EVM transaction (secp256k1), and
  later attesting the EVM outcome with an ECDSA-signed
  `RespondBidirectionalEvent`, signed by a response key derived for THIS
  contract (from the MPC root key, the vault's own address and the fixed path
  `"midnight response key"`). Both responses are posted back on Midnight.
- The vault verifying that response in-circuit against the response key it
  pinned at `initialize` time, and minting or burning shielded vault tokens
  accordingly, including a refund branch for when the EVM leg fails.

# Vault Sign Bidirectional Flow

The flow comprises 5 runtime steps: request a signature on Midnight, receive
the MPC's signature, broadcast on the foreign chain, receive the MPC's
attestation of the outcome, and verify that attestation in-circuit. The vault
runs the whole flow twice, once per direction:

| # | Step | Deposit round trip | Withdraw round trip |
|---|---|---|---|
| 1 | Contract records a signature request and notifies the MPC | `deposit()` requests `transfer(vaultEvmAddress, amount)` on the ERC20, to be signed by the **user's deposit account** | `withdraw()` takes the surrendered vault tokens and requests `transfer(destEvmAddress, amount)`, to be signed by the **vault's account** |
| 2 | MPC posts the transaction signature back to Midnight | Signature by the user's derived key | Signature by the vault's derived key |
| 3 | Client broadcasts the signed transaction on the foreign chain | The ERC20 moves user → vault | The ERC20 moves vault → destination |
| 4 | MPC attests the execution output back to Midnight | Signed `RespondBidirectionalEvent` for the sweep | The same, for the payout |
| 5 | Contract verifies the attestation in-circuit and settles | `claim()` mints shielded vault tokens to the depositor | `completeWithdraw()` finalises, or refunds the withdrawer on EVM failure |

# Derived keys and accounts

Every key the MPC signs with is scoped by the requesting contract:

`derivedSigningKey = f(mpcRootKey[keyVersion], vaultContractAddress, path)`

The path is 32 opaque bytes of the client contract's choosing. There are no
format requirements, and the contract address is always part of the
derivation, so no contract can ever reach another contract's derived keys.
Within one contract, distinct paths yield disjoint accounts. The vault uses
exactly three derivations:

| Account / key | Path | What it does |
|---|---|---|
| The user's deposit account (EVM) | `userCommitment(callerSecretKey)`, the caller's 32-byte identity commitment | Signs the deposit sweep `transfer(vault, amount)`. The user funds this address with the ERC20 being deposited plus gas ETH. One account per identity: the contract recomputes the commitment in-circuit from the secret-key witness, so the path is never a circuit argument and the MPC can only ever sign with THIS caller's account. |
| The vault's own account (EVM) | The contract-fixed literal `"vault"` (`pad(32, "vault")`) | Holds the vault's ERC20 balance and signs every withdraw `transfer(destination, amount)`. It also pays the withdraw gas, which is why the whole fee envelope is contract-fixed. |
| The MPC RESPONSE key (secp256k1, not an account) | The fixed literal `"midnight response key"` | Signs every `RespondBidirectionalEvent` the MPC posts back for this contract, ECDSA over the attestation digest of the request id and execution output. It never signs transactions: it is per-client-contract yet independent of any request's own path, and `claim`/`completeWithdraw` verify responses against it in-circuit. |

Deposits and withdrawals therefore move between two MPC-derived accounts on
the EVM chain, and neither key ever exists anywhere: the MPC network signs
for them on the vault's request, and only through the vault's circuits.

Derivation happens off-chain with the `@sig-net/midnight` helpers:
`deriveEvmAddress(mpcPublicKey, vaultContractAddress, path)` for the two EVM
accounts and `deriveMidnightResponseKey(mpcPublicKey, vaultContractAddress)`
for the response key (the setup pipeline derives all three and prints them).
The vault's own address and the response key both take the contract address
as INPUT, so they cannot exist at construction time: the deployer-gated
one-shot `initialize` circuit pins them right after deploy, when the address
(and therefore the derivations) exist.

One subtlety for raw-hash paths: the MPC reads the 32 opaque path bytes as a
UTF-8 string with NUL bytes stripped when it composes the derivation string.
For the ASCII literals (`"vault"`) that reading is the obvious one, and for
the user's commitment (a raw hash) it is lossy but deterministic, so client
code deriving the user's EVM address must apply the exact same reading (see
`pathStringOfBytes` in the integration tests' `vault-identity.ts`, and the
reader setup snippet in the deposit walkthrough below).

# Integration walkthrough

Integrating the vault with the Sig Network MPC consists of 4 once-off
**setup** steps and 5 per-request **runtime** steps. Each Compact snippet is
abridged from
[`contract/src/erc20-vault.compact`](contract/src/erc20-vault.compact), where
a matching `Setup step N` / `Runtime step N` marker locates the full code.
Each off-chain snippet has an executable counterpart in
[`integration-tests/src/flows/`](integration-tests/src/flows/), the example's
executable documentation.

## Setup (once per vault deployment)

### Setup step 1: add the protocol dependencies

The contract package's dependency list is the minimal integration surface:

```jsonc
// contract/package.json
"dependencies": {
  "@midnight-ntwrk/compact-runtime": "0.18.0-rc.1",
  "@sig-net/midnight": "0.10.0",
  "@sig-net/midnight-contract": "0.10.0"
}
```

`@sig-net/midnight` is the client-agnostic protocol library: the Compact
module the contract imports, plus the TypeScript twins, state readers and
derivation helpers used off-chain. `@sig-net/midnight-contract` supplies the
Signet singleton's compiled artefacts, which the vault's cross-contract calls
link against.

### Setup step 2: import the Signet module and compile

At the top of `erc20-vault.compact`:

```compact
import "@sig-net/midnight/src/Signet";
```

The compile script resolves that import through `node_modules` with
`COMPACT_PATH`, passes the mandatory `--feature-zkir-v3` flag, and links the
Signet singleton's managed artefacts in as `src/managed/SignetSigner` for the
cross-contract call:

```sh
COMPACT_PATH=../../../node_modules compact compile --feature-zkir-v3 \
  src/erc20-vault.compact src/managed/erc20-vault
ln -sfn ../../../../../node_modules/@sig-net/midnight-contract/dist/managed \
  src/managed/SignetSigner
```

This is `yarn compile:zk` in [`contract/package.json`](contract/package.json).
The plain `compile` variant adds `--skip-zk` for fast iteration without
generating proving keys.

### Setup step 3: declare the ledger state

The vault declares the three protocol-required fields (the event map, the
singleton reference, the response key) plus its own state:

```compact
// The three protocol-required fields, kept together: the event map, the
// Signet singleton reference, and the MPC response key.

// The request map the MPC reads deposit and withdraw events back from.
// Sized for an ERC20 transfer(address,uint256): 2 calldata words, no access
// list, and the vault's exact 34-byte response schema. This declaration is
// ledger FIELD 0: the request circuits name this position in their
// notifications and the MPC locates the map by position, so it must stay
// first and never move after the first deploy. No other field's position
// carries meaning.
export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EVMType2TxParams<2, 0, 0>, 34, 34>;

// The Signet singleton the request circuits notify, pinned at deploy.
sealed ledger signetSigner: SignetSigner;

// The MPC response key every response is verified against, set in Setup step 4.
export ledger mpcResponseKey: Secp256k1Point;

// The vault's own state.
export ledger signetRequestNonce: Counter;  // keeps identical requests' ids distinct
export ledger initialized: Counter;         // one-shot initialize marker
export ledger vaultEvmAddress: Bytes<20>;   // the vault's derived EVM account
export ledger evmChainId: Uint<64>;         // the pinned EVM chain, numeric...
export ledger caip2Id: Bytes<32>;           // ...and CAIP-2 form
sealed ledger deployer: Bytes<32>;          // only they may initialize
export ledger refundCommitment: Map<RequestId, Bytes<32>>; // pending withdrawals

constructor(deployerCommitment: Bytes<32>, signetContract: SignetSigner) {
  deployer = disclose(deployerCommitment);
  signetSigner = disclose(signetContract);
}
```

Two vault-specific points:

- The contract package exports the event map's position as
  `VAULT_REQUESTS_INDEX_FIELD` so off-chain readers cannot drift from it.
- The deploy tooling ([`contract/deploy.ts`](contract/deploy.ts)) computes
  `deployerCommitment` off-chain by calling the compiled `userCommitment`
  circuit over the deployer's secret, never a TypeScript re-implementation.

### Setup step 4: pin the derived addresses and the response key

Both post-deploy values take the vault's contract address as derivation
input, so they cannot exist at construction time. Right after deploy, derive
them off-chain:

```ts
import { deriveEvmAddress, deriveMidnightResponseKey } from "@sig-net/midnight";

// The vault's own EVM account: path "vault".
const vaultEvmAddress = deriveEvmAddress(mpcRootPublicKey, vaultContractAddress, "vault");

// The vault's response key: path fixed to "midnight response key" by the protocol.
const mpcResponseKey = deriveMidnightResponseKey(mpcRootPublicKey, vaultContractAddress);
```

and seal them (together with the one EVM chain this vault operates on) with
the deployer-gated one-shot `initialize` circuit:

```compact
export circuit initialize(
  vaultEvm: Bytes<20>,
  chainId: Uint<64>,
  chainCaip2Id: Bytes<32>,
  responseKey: Secp256k1Point
): [] {
  assert(initialized == 0, "Already initialized");
  assert(userCommitment(callerSecretKey()) == deployer, "Not the deployer");
  assert(chainId > 0 as Uint<64>, "Chain ID must be positive");
  initialized.increment(1);
  vaultEvmAddress = disclose(vaultEvm);
  evmChainId = disclose(chainId);
  caip2Id = disclose(chainCaip2Id);
  mpcResponseKey = disclose(responseKey);
}
```

The gate prevents front-running: nobody else can initialise the vault to
point at their own address, chain or key. Flow function:
[`initialize.ts`](integration-tests/src/flows/initialize.ts). The setup
pipeline derives and prints all three derived values as `EVM_VAULT_ADDRESS`,
`EVM_USER_ADDRESS` and `MPC_RESPONSE_KEY`.

## Runtime: the deposit round trip

A deposit moves ERC20 value from the user's deposit account into the vault's
account on the EVM chain, then mints the same amount of shielded vault tokens
on Midnight. Before step 1 the user's deposit account must hold the ERC20
being deposited plus some ETH for gas: the local-stack setup pipeline funds
it automatically, and on a real chain you fund the printed
`EVM_USER_ADDRESS`.

Every circuit call goes through the deployed vault, joined once with the
caller's secret key as private state (the witnesses answer the contract's
`callerSecretKey()` from it during proving):

```ts
import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import { createVaultPrivateState } from "@midnight-examples/erc20-vault-contract";

const vault = await findDeployedContract(providers, {
  contractAddress: vaultContractAddress,
  compiledContract: vaultCompiledContract, // the compiled contract bound to its witnesses
  privateStateId: "erc20-vault",
  initialPrivateState: createVaultPrivateState(callerSecretKey),
});
```

The off-chain steps (2 to 4) share one `SignetRequestResponseReader` over the
vault / singleton pair, and the expected signer of the deposit sweep is the
user's deposit account, derived from the caller's identity commitment:

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { deriveEvmAddress, SignetRequestResponseReader } from "@sig-net/midnight";
import { pureCircuits, VAULT_REQUESTS_INDEX_FIELD } from "@midnight-examples/erc20-vault-contract";

const reader = new SignetRequestResponseReader({
  // The deployed vault contract.
  requesterContractAddress: vaultContractAddress,

  // signBidirectionalEventMap sits at ledger field 0 (Setup step 3).
  requesterRequestsIndexField: VAULT_REQUESTS_INDEX_FIELD,

  // The Signet singleton contract.
  signetContractAddress,

  // Provider to index the Midnight blockchain.
  publicDataProvider: indexerPublicDataProvider({
    queryURL: indexerUrl,
    subscriptionURL: indexerWsUrl,
  }),
});

// The MPC reads the 32 opaque path bytes as UTF-8 with NULs stripped (see
// Derived keys and accounts above), so the commitment is read the same way:
const pathStringOfBytes = (path: Uint8Array) =>
  Buffer.from(path).toString("utf8").replace(/\0/g, "");

// Deposit sweeps are signed by the USER's deposit account: the derivation
// path is the caller's identity commitment, computed with the vault's
// compiled circuit (never a TypeScript re-implementation).
const userCommitment = pureCircuits.userCommitment(callerSecretKey);
const evmUserAddress = deriveEvmAddress(
  mpcRootPublicKey,
  vaultContractAddress,
  pathStringOfBytes(userCommitment),
);
```

### Runtime step 1: `deposit()` records the request

The user calls the deposit circuit on Midnight. The contract composes the
ENTIRE transaction itself: the calldata is `transfer(vaultEvmAddress, amount)`
built in-circuit around the initialize-pinned recipient (which is what stops
a malicious client having the MPC sign a transfer to themselves), and the
derivation path is the caller's identity commitment recomputed from the
secret-key witness, so it is not even an argument. The caller supplies only
what is genuinely theirs to choose: their account's nonce, the gas envelope
their account pays, and the MPC key version.

```compact
export circuit deposit(
  evmNonce: Uint<64>,
  gasLimit: Uint<64>,
  maxFeePerGas: Uint<128>,
  maxPriorityFeePerGas: Uint<128>,
  keyVersion: Uint<8>,
  depositRequest: DepositRequest  // { erc20Address: Bytes<20>, amount: Uint<128> }
): SignetMapKey {
  // The request's derivation path IS the caller's identity commitment.
  const caller = disclose(userCommitment(callerSecretKey()));

  // Contract-enforced calldata: transfer(vaultEvmAddress, amount). The words
  // are ABI-ready (big-endian): the signer uses them verbatim.
  const calldata = EVMCalldata<2> {
    selector: Bytes [0xa9, 0x05, 0x9c, 0xbb], // transfer(address,uint256)
    noWords: 2 as Uint<16>,
    words: [
      evmAddressAbiWord(vaultEvmAddress),
      numericAbiWord(depositRequest.amount),
    ]
  };
  // ... assemble EVMType2TxParams for the deposit's ERC20 on the
  //     initialize-pinned chain, carrying no ETH ...

  const request = constructSignBidirectionalEvent<EVMType2TxParams<2, 0, 0>, 34, 34>(
    kernel.self(),
    requestNonce,
    keyVersion,
    caller,                         // derivation path = the depositor's commitment
    MPCSignatureAlgorithm.ecdsa,
    MPCDestination.unused,
    pad(64, ""),
    TxParamType.evmType2,
    txParams,
    caip2Id,
    schema,
    schema
  );
  const requestId = disclose(calculateRequestId<EVMType2TxParams<2, 0, 0>, 34, 34>(request));

  // Store the request for the MPC to discover...
  signetRequestNonce.increment(1);
  signBidirectionalEventMap.insert(requestId, disclose(request));

  // ...and notify it, naming the map's field position (0, Setup step 3).
  return signetSigner.signBidirectionalEvent(
    requestId,
    constructSignBidirectionalEventNotificationV1(kernel.self(), 0 as Uint<8>),
  );
}
```

Invoking it, and getting the request id every later step keys on:

```ts
import { JsonRpcProvider } from "ethers";
import { calculateRequestId, requestIdHex, SIGNET_DEFAULT_KEY_VERSION } from "@sig-net/midnight";

// The sweep sender is the user's deposit account: fetch its next nonce.
const evmNonce = await new JsonRpcProvider(evmRpcUrl).getTransactionCount(evmUserAddress);

await vault.callTx.deposit(
  BigInt(evmNonce),
  100_000n,         // gasLimit: the user's account pays
  30_000_000_000n,  // maxFeePerGas (wei)
  1_000_000_000n,   // maxPriorityFeePerGas (wei)
  SIGNET_DEFAULT_KEY_VERSION,
  { erc20Address, amount },
);

// The ledger map key IS the record's hash: rebuild the expected event record
// and hash it with the library's TypeScript twin.
const requestId = requestIdHex(calculateRequestId(expectedRecord));
```

[`deposit.ts`](integration-tests/src/flows/deposit.ts) shows the full
`expectedRecord` reconstruction, byte for byte, and asserts the recomputed id
appears as a ledger map key after the call.

### Runtime step 2: poll for the MPC's signature

The singleton's signature response log is unauthenticated (anyone can post),
so use the verifying getter: it only returns a post whose signature recovers
to the user's deposit account over the sweep's signing hash:

```ts
const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, evmUserAddress);
// verified === undefined: no valid response posted yet, poll again.
```

Flow function:
[`poll-signature-response.ts`](integration-tests/src/flows/poll-signature-response.ts).

### Runtime step 3: broadcast the sweep to the EVM chain

The reader rebuilds the transaction from the request record on the vault's
ledger and attaches the verified MPC signature:

```ts
import { JsonRpcProvider } from "ethers";

const signedSweep = await reader.getSignedEVMTransaction(requestId, evmUserAddress);
await new JsonRpcProvider(evmRpcUrl).broadcastTransaction(signedSweep.serialized);
```

The ERC20 moves from the user's deposit account into the vault's account.
Flow function: [`broadcast-evm.ts`](integration-tests/src/flows/broadcast-evm.ts)
(idempotent: an already-mined sweep short-circuits cleanly, a reverted or
nonce-burned one throws).

### Runtime step 4: poll for the MPC's attestation

Once the MPC observes the mined receipt it posts an ECDSA-signed
`RespondBidirectionalEvent` of the outcome. These posts are also stored
unverified, so judge each candidate off-chain with the compiled circuit
against the vault's pinned response key, the SAME check `claim` runs
in-circuit in step 5:

```ts
import { pureCircuits as signetCircuits, requestIdBytes } from "@sig-net/midnight";

const events = await reader.getRespondBidirectionalEvents(requestId);
const attestation = events.find((event) =>
  signetCircuits.verifyRespondBidirectionalEvent(
    requestIdBytes(requestId),
    event,
    vaultLedgerState.mpcResponseKey,   // read from the vault's public ledger
  ),
);
// undefined: nothing verifying posted yet, poll again.
```

Flow function:
[`poll-respond-bidirectional.ts`](integration-tests/src/flows/poll-respond-bidirectional.ts).

### Runtime step 5: `claim()` verifies and mints

The depositor presents the attestation to the vault, which re-verifies it
in-circuit and mints shielded vault tokens for the deposited amount, to the
caller or to an optional alternate recipient's coin public key:

```compact
export circuit claim(
  requestId: RequestId,
  respondBidirectionalEvent: RespondBidirectionalEvent,
  mintNonce: Bytes<32>,
  recipient: Maybe<Either<ZswapCoinPublicKey, ContractAddress>>,
): [] {
  // The EVM result: the first output word is transfer()'s ABI-encoded bool.
  const returnValue = slice<32>(respondBidirectionalEvent.serializedOutput, 0);
  assert(returnValue as Field == 1 as Field, "ERC20 transfer returned false");

  // The only authentication gate: in-circuit ECDSA over the attestation
  // digest of (requestId, output), against the initialize-pinned response key.
  assert(
    verifyRespondBidirectionalEvent(disclosedRequestId, respondBidirectionalEvent, mpcResponseKey),
    "Invalid attestation signature"
  );

  // Double-claim protection: the request must exist and is consumed here.
  const signatureRequest = signBidirectionalEventMap.lookup(disclosedRequestId);
  signBidirectionalEventMap.remove(disclosedRequestId);

  // Depositor gate: the caller's recomputed commitment must match the
  // request's derivation path, which deposit set to the depositor's commitment.
  assert(userCommitment(callerSecretKey()) == signatureRequest.path, "Not the depositor");

  // Mint shielded vault tokens for the deposited amount (calldata word 1),
  // under the token colour of the deposited ERC20 (txParams.to).
  mintShieldedToken(domainSep, amount as Uint<64>, disclose(mintNonce), claimRecipient);
}
```

Invoking it:

```ts
import { requestIdBytes } from "@sig-net/midnight";

// A fresh RANDOM mint nonce per claim: one derived from the (public) request
// id would let any observer link the minted coin to the deposit.
const mintNonce = crypto.getRandomValues(new Uint8Array(32));

// Mint to the caller's own wallet (recipient: none). Compact's Maybe/Either
// are plain structs, so a `none` still carries a default-valued payload.
await vault.callTx.claim(requestIdBytes(requestId), attestation, mintNonce, {
  is_some: false,
  value: { is_left: true, left: { bytes: new Uint8Array(32) }, right: { bytes: new Uint8Array(32) } },
});
```

The deposited amount is now in the caller's wallet as shielded vault tokens.
Flow function: [`claim.ts`](integration-tests/src/flows/claim.ts), including
how to mint to a different wallet's coin public key instead.

## Runtime: the withdraw mirror

Withdrawal runs the same five runtime steps with the roles swapped. The
caller surrenders shielded vault tokens up front, and the requested EVM
transfer spends from the vault's own account:

| | Deposit round trip | Withdraw round trip |
|---|---|---|
| Runtime step 1 | `deposit()` | `withdraw()`, which also takes (and burns) the surrendered coin |
| Derivation path → signer | The caller's identity commitment → the user's deposit account | `"vault"` → the vault's own account |
| Who pays the EVM gas | The user's account, caller-chosen envelope | The vault's account, contract-fixed envelope |
| Runtime step 2 `expectedSigner` | `evmUserAddress` | `evmVaultAddress = deriveEvmAddress(mpcRootPublicKey, vaultContractAddress, "vault")` |
| Runtime steps 3 and 4 | Identical mechanics | Identical mechanics |
| Runtime step 5 | `claim()`: depositor-only, mints on success | `completeWithdraw()`: open to anyone on success, withdrawer-only refund on failure |

The whole round trip at a glance
([`withdraw.ts`](integration-tests/src/flows/withdraw.ts) /
[`complete-withdraw.ts`](integration-tests/src/flows/complete-withdraw.ts)):

```ts
// Runtime step 1: surrender a vault coin and record the request. midnight-js
// funds the coin from the caller's shielded balance when balancing the call.
const coin = {
  nonce: crypto.getRandomValues(new Uint8Array(32)),
  color: vaultTokenColor, // from the compiled vaultTokenDomainSeparator + rawTokenType
  value: amount,
};
const evmNonce = await evmProvider.getTransactionCount(evmVaultAddress); // the VAULT's account sends
await vault.callTx.withdraw(
  BigInt(evmNonce),
  SIGNET_DEFAULT_KEY_VERSION,
  { erc20Address, amount, destEvmAddress },
  coin,
);
const requestId = requestIdHex(calculateRequestId(expectedRecord)); // as in the deposit

// Runtime step 2: poll for the MPC's signature, which must recover to the
// VAULT's account this time.
const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, evmVaultAddress);

// Runtime step 3: broadcast the payout. The ERC20 moves vault → destination.
const signedPayout = await reader.getSignedEVMTransaction(requestId, evmVaultAddress);
await evmProvider.broadcastTransaction(signedPayout.serialized);

// Runtime step 4: poll and verify the MPC's attestation, exactly as in the deposit.
const attestation = /* getRespondBidirectionalEvents + verifyRespondBidirectionalEvent */;

// Runtime step 5: settle. The branch (finalise or refund) follows the
// MPC-signed outcome, never the caller.
await vault.callTx.completeWithdraw(
  requestIdBytes(requestId),
  attestation,
  crypto.getRandomValues(new Uint8Array(32)), // random mint nonce, for the refund branch
);
```

The two vault-side circuits in detail:

### Runtime step 1: `withdraw()` burns and requests

`withdraw()` is optimistic: the surrendered coin is taken first, and the
refund path exists for when the EVM leg later fails. The coin spend IS the
authorisation (the wallet funds it from the caller's own balance), so anyone
may withdraw to any destination. The vault's account pays the withdraw gas,
so the entire fee envelope is contract-fixed rather than caller-chosen: a
caller-supplied fee cap would let anyone burn the vault account's ETH at
will.

```compact
export circuit withdraw(
  evmNonce: Uint<64>,
  keyVersion: Uint<8>,
  withdrawRequest: WithdrawRequest, // { erc20Address, amount, destEvmAddress }
  coin: ShieldedCoinInfo
): SignetMapKey {
  // The coin must be the vault token for THIS ERC20, of exactly `amount`.
  const color = tokenType(
    vaultTokenDomainSeparator(disclose(withdrawRequest.erc20Address)),
    kernel.self()
  );
  assert(coin.color == color, "Coin is not the vault token for this ERC20");
  assert(coin.value == withdrawRequest.amount, "Coin value must equal the withdraw amount");

  // Contract-enforced calldata: transfer(destEvmAddress, amount), inside a
  // contract-FIXED gas envelope (gasLimit 100000, maxFeePerGas 30 gwei).
  // ... assemble EVMType2TxParams exactly as in deposit ...

  // The request is keyed under the vault's OWN derivation path.
  const path = pad(32, "vault");
  // ... constructSignBidirectionalEvent + calculateRequestId as in deposit ...

  // The surrendered value is BURNED here: the coin is paid to the contract
  // and deliberately never recorded, so it can never be spent. Vault tokens
  // are IOUs, and a refund MINTS fresh ones.
  receiveShielded(disclose(coin));

  // Record the request and pin the withdrawer's refund commitment (only the
  // hash reaches the ledger, the refund recipient's key stays private).
  signBidirectionalEventMap.insert(requestId, disclose(request));
  refundCommitment.insert(requestId, disclose(withdrawRefundCommitment(callerSecretKey(), requestId)));

  return signetSigner.signBidirectionalEvent(
    requestId,
    constructSignBidirectionalEventNotificationV1(kernel.self(), 0 as Uint<8>),
  );
}
```

Flow function: [`withdraw.ts`](integration-tests/src/flows/withdraw.ts). Then
steps 2 to 4 run exactly as in the deposit round trip, with
`expectedSigner: evmVaultAddress`.

### Runtime step 5: `completeWithdraw()` settles both branches

The branch is decided by the MPC-signed output, never by the caller. On
success the withdrawal is final (the surrendered value stays burned) and the
call only cleans up, so ANYONE holding the signed response may settle it. On
failure the value re-mints to the WITHDRAWER only, who proves the secret
behind the commitment pinned at withdraw time:

```compact
export circuit completeWithdraw(
  requestId: RequestId,
  respondBidirectionalEvent: RespondBidirectionalEvent,
  mintNonce: Bytes<32>,
): [] {
  // Same authentication gate as claim: in-circuit ECDSA against the pinned key.
  assert(
    verifyRespondBidirectionalEvent(disclosedRequestId, respondBidirectionalEvent, mpcResponseKey),
    "Invalid attestation signature"
  );

  // Double-settle protection: refundCommitment doubles as the
  // pending-withdrawal marker (deposits never insert it, so a deposit can
  // never be settled through this circuit).
  assert(refundCommitment.member(disclosedRequestId), "Withdrawal not found");
  const signatureRequest = signBidirectionalEventMap.lookup(disclosedRequestId);
  signBidirectionalEventMap.remove(disclosedRequestId);

  // Branch on the MPC-signed EVM result: 0x01 first byte = success, anything
  // else (a false return, or the MPC's 0xdeadbeef error sentinel) = refund.
  const succeeded = disclose(slice<1>(respondBidirectionalEvent.serializedOutput, 0) as Field == 1 as Field);
  if (!succeeded) {
    // Withdrawer-only: prove the secret behind the pinned refund commitment,
    // then re-mint the surrendered value under the caller's random mintNonce.
    assert(
      withdrawRefundCommitment(callerSecretKey(), disclosedRequestId)
        == refundCommitment.lookup(disclosedRequestId),
      "Not the withdrawer"
    );
    mintShieldedToken(domainSep, amount as Uint<64>, disclose(mintNonce), recipient);
  }
  refundCommitment.remove(disclosedRequestId);
}
```

The refund mints under a fresh random nonce so it is unlinkable to the
request, and the refund commitment is deliberately a DIFFERENT scheme from
`userCommitment` (distinct domain string, plus the request id mixed in): the
deposit path publishes the user commitment on the ledger, so reusing it here
would let anyone link a withdrawal's refund marker to a depositor's identity.
Flow function:
[`complete-withdraw.ts`](integration-tests/src/flows/complete-withdraw.ts).

# Package layout

| Package | What it is |
|---|---|
| [`contract/`](contract/) | The Compact contract (`src/erc20-vault.compact`), its witnesses, a curated environment-agnostic export surface, simulator unit tests, and a deploy entrypoint. Its dependency list (`@sig-net/midnight`, `@sig-net/midnight-contract` and the compact tooling) is the minimal integration surface. |
| [`integration-tests/`](integration-tests/) | The executable documentation: typed in-process flow functions (`src/flows/`) driving every runtime step above, the setup pipeline that deploys the whole stack, six e2e specs, and the example's TestUSDC ERC20. |

# Running it

Everything runs from the repo root against the local docker stack (Midnight
node, indexer, proof server, anvil EVM, fakenet MPC responder). No
pre-existing `.env` is required. The setup pipeline creates one and records
everything it deploys so that later runs reuse the same contracts.

```sh
corepack enable
yarn install
compact update 0.33.0-rc.2          # Exact version required.
yarn compile:erc20-vault:zk         # ~10 min zk key generation, background it
docker compose up -d
yarn test:erc20-vault:e2e           # the six e2e specs, serially, bail on first failure
```

Offline checks that need no stack and no proving keys beyond `yarn compile`:

```sh
yarn compile:erc20-vault            # generate src/managed (skip-zk)
yarn build                          # typecheck everything
yarn test:erc20-vault               # simulator unit tests + offline-skipped e2e files
```

Deploy a fresh vault by hand (the e2e setup does this automatically when the
`.env` has no vault address):

```sh
yarn deploy:erc20-vault
```

**TIP:** If you are using Claude Code you can ask it to run these tests for
you using this [skill](../../.claude/skills/e2e/SKILL.md). It knows the whole
operational runbook (rerun vs redeploy modes, the fakenet responder hand-off,
failure recovery) and will drive it for you.

# The e2e suite

Six specs run serially in a pinned order (see
`integration-tests/vitest.config.ts`). `happy-day-e2e` runs first because it
initialises the vault and cycles the funds that the later flows build on.
Each spec is rerun-tolerant against kept contract addresses and prints resume
ids in banners as it goes, for recovering a run that died mid-flow.

| Spec | Tests | What it proves | Resume var(s) |
|---|---|---|---|
| `happy-day-e2e` | 15 | Full deposit + withdraw round trips, every leg asserted (incl. the MPC-convention reads a responder does) | `DEPOSIT_REQUEST_ID`, `WITHDRAW_REQUEST_ID` |
| `deposit-withdrawal-failure-refund` | 9 | A withdraw whose EVM transfer reverts ends in an in-circuit REFUND of the escrowed shielded value | `FAILURE_REFUND_DEPOSIT_REQUEST_ID`, `FAILURE_REFUND_WITHDRAW_REQUEST_ID` |
| `deposit-claimant-not-caller` | 6 | `claim` can direct the mint to a different wallet's coin public key, discovered from chain data alone | `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID` |
| `benchmark` | 13 | Per-leg wall-clock report of both round trips (`BENCHMARK_TIMINGS_JSON` greppable line) | `BENCHMARK_DEPOSIT_REQUEST_ID`, `BENCHMARK_WITHDRAW_REQUEST_ID` |
| `false-claimer` | 6 | A deposit recorded for identity A is NOT claimable by identity B, even with the valid MPC attestation | `FALSE_CLAIMER_DEPOSIT_REQUEST_ID` |
| `bearer-transfer` | 11 | Shielded vault tokens are bearer assets: a plain Midnight transfer hands the claim to wallet B, the emptied wallet A can no longer withdraw, and B completes a full withdraw on the transferred balance | `BEARER_TRANSFER_DEPOSIT_REQUEST_ID`, `BEARER_TRANSFER_WITHDRAW_REQUEST_ID` |

60 tests total. A rerun against kept contract addresses (a populated `.env`)
completes in roughly 25–35 minutes on a laptop. A fresh deployment adds the
setup pipeline's deploys (a few minutes) on top, and a cold clone adds the
~10 minute zk key generation. The claim/settle proofs are the heavy legs: the
proof server peaks above 12 GiB, so give the docker VM 16 GB.

# Test run recovery

The proof server being OOM-killed mid-run is routine on a 16 GB Docker VM and
not a defect. It presents as a spec failing with
`connect ECONNREFUSED 127.0.0.1:6300`, with `docker ps -a` showing
`midnight-proof-server` as `Exited (137)` (confirm with
`docker inspect midnight-proof-server --format '{{.State.OOMKilled}}'`).
You do not need to start over. Every on-chain step that already completed
stays completed, and each spec prints its request ids in banners as it goes.

To recover:

1. `docker restart midnight-proof-server`
2. Rerun the same spec file, passing the request id it printed via the spec's
   resume env var (see the table above) so that it resumes the pending
   request instead of spending a fresh deposit:

   ```sh
   DEPOSIT_REQUEST_ID=<id from the banner> \
     yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts
   ```

The flows are rerun-tolerant: already-mined EVM broadcasts skip through
idempotently and already-claimed or settled requests are skipped cleanly. If
the spec died on the proving call itself and printed no request-id banner
then there is nothing to resume. Rerun the spec plain and it spends a fresh
deposit. On the rerun the interrupted proof is the first one served by a
fresh proof server, so the rest of the file fits in the remaining headroom.

One corner case: if the proof server died while the fakenet responder was
posting a response, that request strands unresponded (a signature poll then
times out even though the responder logged the request). Recover with
`docker compose --profile fakenet restart fakenet` (its startup backfill
re-posts the missing responses), then rerun with the resume var as above.

**TIP:** If you are using Claude Code you can ask it to run the suite for you
using this [skill](../../.claude/skills/e2e/SKILL.md). It will handle the
proof server restarts and resume vars between failures for you.
