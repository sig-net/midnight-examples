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

- A Compact contract requesting EVM transaction signatures from the Signature Network singleton contract with a cross-contract call on Midnight.
- The MPC observing the request, signing the EVM transaction (secp256k1), and later attesting the EVM outcome with an ECDSA-signed `RespondBidirectionalEvent`, signed by a response key derived for THIS contract (from the MPC root key, the vault's own address and the fixed path `"midnight response key"`). Both responses are emitted as contract events on Midnight.
- The vault verifying that response in-circuit against the response key it
  pinned at `initialise` time, and minting or burning shielded vault tokens
  accordingly, including a refund branch for when the EVM leg fails.

# The vault's circuits

Every circuit is a variation on one shape: record a signature request, let the
MPC sign and broadcast it, then settle in-circuit against the MPC's attestation.
The walkthrough below documents that shape in full for **`startDeposit` → `completeDeposit`**;
the rest of the circuits reuse it, so the table names each and what it adds
without repeating the detail.

| Circuit(s) | What it adds over `startDeposit` → `completeDeposit` |
|---|---|
| `startDeposit` → `completeDeposit` | **The reference flow, documented in full below.** Request → sign → broadcast → attest → verify-and-mint. |
| `startWithdraw` / `completeWithdraw` | The same flow in the other direction, plus the coin-spend-as-authorisation pattern and a settle circuit that branches on the EVM result. |
| `refundWithdraw` / `refundSwap` / `refundSupply` / `refundRedeem` | Settling a request whose transaction never executed, routed by the 5-byte failure-output width. One refund circuit per request kind, each reading only its own kind's pending marker. |
| `approveRouter` | A sign-only request, with no settle circuit at all. |
| `startSwap` / `completeSwap` | Its own request map, sized to a wider calldata (the width is part of the ledger type), reusing the same optimistic burn-then-mint shape. exactOutputSingle: mint the exact `amountOut` of tokenOut plus the unspent tokenIn as change. |
| `approveStata` | `approveRouter` for the Aave leg: a sign-only approve(stataToken, MAX) on the pinned underlying USDC, so the wrapper can pull it during supply. |
| `startSupply` / `completeSupply` | Aave lending via the pinned ERC-4626 stataUSDC wrapper: burn shielded USDC, record `deposit(amount, vault)`, then mint shielded stataUSDC for the MPC-attested shares. |
| `startRedeem` / `completeRedeem` | The Aave exit: burn shielded stataUSDC, record `redeem(shares, vault, vault)`, then mint shielded USDC for the MPC-attested assets (principal + accrued interest). |

# Vault Sign Bidirectional Flow

The flow comprises 5 runtime steps: request a signature on Midnight, receive
the MPC's signature, broadcast on the foreign chain, receive the MPC's
attestation of the outcome, and verify that attestation in-circuit. The vault
runs the whole flow twice, once per direction:

| # | Step | Deposit round trip | Withdraw round trip |
|---|---|---|---|
| 1 | Contract records a signature request and notifies the MPC | `startDeposit()` requests `transfer(vaultEvmAddress, amount)` on the ERC20, to be signed by the **user's deposit account** | `startWithdraw()` takes the surrendered vault tokens and requests `transfer(destEvmAddress, amount)`, to be signed by the **vault's account** |
| 2 | MPC posts the transaction signature back to Midnight | Signature by the user's derived key | Signature by the vault's derived key |
| 3 | Client broadcasts the signed transaction on the foreign chain | The ERC20 moves user → vault | The ERC20 moves vault → destination |
| 4 | MPC attests the execution output back to Midnight | Signed `RespondBidirectionalEvent` for the sweep | The same, for the payout |
| 5 | Contract verifies the attestation in-circuit and settles | `completeDeposit()` mints shielded vault tokens to the depositor | `completeWithdraw()` finalises an executed transfer, or refunds the withdrawer on a false return. `refundWithdraw()` refunds the withdrawer when the transfer never executed (reverted or replaced) |

> **Output recovery (between steps 4 and 5):** the attestation event carries the request id it answers and the MPC's signature, never the output, so the client recovers the execution output itself. For EVM chains it is the mined call's return data, extracted with `debug_traceTransaction` (callTracer, top call frame), the same RPC method the MPC observes executions with. This example fetches it from the fakenet responder's helper API at `GET /responses/{requestId}` (client in [`integration-tests/src/fakenet-responses.ts`](integration-tests/src/fakenet-responses.ts), signature verification in [`integration-tests/src/flows/respond-output.ts`](integration-tests/src/flows/respond-output.ts), server in [`ResponsesApi.ts`](https://github.com/sig-net/solana-signet-program/blob/fakenet-v0.10.0/fakenet-signer/src/server/ResponsesApi.ts), port 3040 in the local stack). The fetched bytes are untrusted until step 5's in-circuit signature verification.

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
| The MPC RESPONSE key (secp256k1, not an account) | The fixed literal `"midnight response key"` | Signs every `RespondBidirectionalEvent` the MPC posts back for this contract, ECDSA over the attestation digest of the request id and execution output (the event carries the id it answers plus the signature, nothing else). It never signs transactions: it is per-client-contract yet independent of any request's own path, and `completeDeposit`/`completeWithdraw` verify responses against it in-circuit. |

Deposits and withdrawals therefore move between two MPC-derived accounts on
the EVM chain, and neither key ever exists anywhere: the MPC network signs
for them on the vault's request, and only through the vault's circuits.

Derivation happens off-chain with the `@sig-net/midnight` helpers:
`deriveEvmAddress(mpcPublicKey, vaultContractAddress, path)` for the two EVM
accounts and `deriveMidnightResponseKey(mpcPublicKey, vaultContractAddress)`
for the response key (the setup pipeline derives all three and prints them).
The vault's own address and the response key both take the contract address
as INPUT, so they cannot exist at construction time: the deployer-gated
one-shot `initialise` circuit pins them right after deploy, when the address
(and therefore the derivations) exist.

The MPC composes the derivation string by rendering the 32 opaque path bytes
as their full-width lowercase hex (no `0x` prefix, padding included), a total
and injective rendering that accepts any bytes the contract chooses. Client
code deriving an account off-chain must feed `deriveEvmAddress` the same
rendering: `bytesToHex` of the stored path bytes, so the vault's own account
derives from the hex of `pad(32, "vault")` and the user's account from the
hex of the identity commitment (see the reader setup snippet in the deposit
walkthrough below).

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
  "@sig-net/midnight": "0.18.0",
  "@sig-net/midnight-contract": "0.18.0"
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

// The request map the MPC reads approve and withdraw events back from.
// Sized for an ERC20 transfer(address,uint256): 2 calldata words, no access
// list, and the vault's exact 34-byte response schema. Its resolved
// ledger-tree path is what the request circuits pack into their
// notifications, and the MPC follows that path to locate the map, so every
// field's position is load-bearing once deployed.
export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EvmType2TxParams<2, 0, 0>, 34, 34>;

// The Signet singleton the request circuits notify, pinned at deploy.
sealed ledger signetSigner: SignetSigner;

// The MPC response key every response is verified against, set in Setup step 4.
export ledger mpcResponseKey: Secp256k1Point;

// The vault's own state.
export ledger signetRequestNonce: Counter;  // keeps identical requests' ids distinct
export ledger initialised: Counter;         // one-shot initialise marker
export ledger vaultEvmAddress: Bytes<20>;   // the vault's derived EVM account
export ledger evmChainId: Uint<64>;         // the pinned EVM chain, numeric...
export ledger caip2Id: Bytes<32>;           // ...and CAIP-2 form
sealed ledger deployer: Bytes<32>;          // only they may initialise
// Deposits get their own map: kind isolation is structural, so completeDeposit
// never sees an approve or withdraw request at all.
export ledger depositEventMap: SignBidirectionalEventMap<EvmType2TxParams<2, 0, 0>, 34, 34>;
export ledger depositSettleViews: Map<RequestId, DepositSettleView>;   // pending deposits: depositor commitment + typed token/amount
export ledger withdrawSettleViews: Map<RequestId, WithdrawSettleView>; // pending withdrawals: gate commitment + typed token/amount

constructor(deployerCommitment: Bytes<32>, signetContract: SignetSigner) {
  deployer = disclose(deployerCommitment);
  signetSigner = disclose(signetContract);
}
```

Two vault-specific points:

- The contract package exports each request map's resolved ledger-tree path
  (`VAULT_REQUESTS_PATH`, `VAULT_DEPOSIT_REQUESTS_PATH`,
  `VAULT_SWAP_REQUESTS_PATH`, `VAULT_SUPPLY_REQUESTS_PATH`,
  `VAULT_REDEEM_REQUESTS_PATH`) so off-chain readers cannot drift from them.
  The vault has 21 ledger fields, past the 15-field flat limit, so the compiler
  chunks the state tree: chunk 0 holds fields 0-5, chunk 1 holds fields 6-20,
  and every path is depth 2. The approve/withdraw map at field 0 has the path
  `[0, 0]`, and its circuits pack `requestsPathDepth` 2 + `requestsPath`
  [0, 0, 0, 0]; the deposit map at field 9 has `[1, 3]` and packs
  [1, 3, 0, 0]. The compiler records the same paths as each field's "index" in
  the compiled `contract-info.json`, and a ledger declaration change re-chunks
  the tree, so re-read them there and update every notification vector in the
  same change.
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
the deployer-gated one-shot `initialise` circuit:

```compact
export circuit initialise(
  vaultEvm: Bytes<20>,
  chainId: Uint<64>,
  chainCaip2Id: Bytes<32>,
  responseKey: Secp256k1Point
): [] {
  assert(initialised == 0, "Already initialised");
  assert(userCommitment(callerSecretKey()) == deployer, "Not the deployer");
  assert(chainId > 0 as Uint<64>, "Chain ID must be positive");
  initialised.increment(1);
  vaultEvmAddress = disclose(vaultEvm);
  evmChainId = disclose(chainId);
  caip2Id = disclose(chainCaip2Id);
  mpcResponseKey = disclose(responseKey);
}
```

The gate prevents front-running: nobody else can initialise the vault to
point at their own address, chain or key. Flow function:
[`initialise.ts`](integration-tests/src/flows/initialise.ts). The setup
pipeline derives and prints all three derived values as `EVM_VAULT_ADDRESS`,
`EVM_USER_ADDRESS` and `MPC_RESPONSE_KEY`.

## Deploying

The contract has 17 circuits and their verifier keys do not fit in one block, so
a deploy is two phases:

1. The base transaction registers the whole ledger state and ONE small circuit.
2. Every remaining circuit is added afterwards, one maintenance update each.

The order matters and is not symmetric. Ledger state cannot be added after
deploy, so the base transaction must carry the final ledger declarations even
for circuits it does not register yet. Circuits can be added at any time.

[`contract/deploy.ts`](contract/deploy.ts) performs both phases and is the only
implementation. The e2e setup runs it as a subprocess, and so does the stagenet
script, so local and remote deploys take the same path:

```sh
# local, against the docker stack
yarn workspace @midnight-examples/erc20-vault-contract deploy

# stagenet: deploy, then run the deployer-gated initialise
yarn workspace @midnight-examples/erc20-vault-integration-tests exec \
  tsx deploy-init-stagenet.ts
```

`BASE_DEPLOY_CIRCUITS` names the circuit that goes in the base transaction.
`buildDeployTransactionDeferring` returns the contract address plus the deferred
list, and each deferred circuit is then added at the next maintenance-authority
counter, waiting for the counter to advance between updates.

### MAINTENANCE_SIGNING_KEY

The base deploy retains a maintenance authority, and this variable is its
signing key. Every circuit added after the base transaction is signed by it.

Set it to a 32-byte hex key you keep. Unset, the deploy generates an ephemeral
one and says so, which is fine for a throwaway deploy and wrong anywhere else:
it is the only way to add or replace a circuit later, and an ephemeral key is
gone when the process exits.

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
import {
  deriveEvmAddress,
  signetEventSourceFromPublicDataProvider,
  SignetRequestResponseReader,
} from "@sig-net/midnight";
import { pureCircuits, VAULT_DEPOSIT_REQUESTS_PATH } from "@midnight-examples/erc20-vault-contract";

// Provider to index the Midnight blockchain.
const publicDataProvider = indexerPublicDataProvider({
  queryURL: indexerUrl,
  subscriptionURL: indexerWsUrl,
});

const reader = new SignetRequestResponseReader({
  // The deployed vault contract.
  requesterContractAddress: vaultContractAddress,

  // depositEventMap sits at ledger field 9, path [1, 3] (Setup step 3).
  requesterRequestsPath: VAULT_DEPOSIT_REQUESTS_PATH,

  // The Signet singleton contract.
  signetContractAddress,

  // Raw contract state: the vault's authenticated request map.
  publicDataProvider,

  // The contract events the singleton emits (the MPC's responses), read
  // through the same provider.
  eventSource: signetEventSourceFromPublicDataProvider(publicDataProvider),
});

// Deposit sweeps are signed by the USER's deposit account: the derivation
// path is the caller's identity commitment, computed with the vault's
// compiled circuit (never a TypeScript re-implementation) and rendered as
// its full-width lowercase hex, the MPC's rendering of every record's 32
// opaque path bytes (see Derived keys and accounts above).
const userCommitment = pureCircuits.userCommitment(callerSecretKey);
const evmUserAddress = deriveEvmAddress(
  mpcRootPublicKey,
  vaultContractAddress,
  bytesToHex(userCommitment),
);
```

### Runtime step 1: `startDeposit()` records the request

The user calls the deposit circuit on Midnight. The contract composes the
ENTIRE transaction itself: the calldata is `transfer(vaultEvmAddress, amount)`
built in-circuit around the initialise-pinned recipient (which is what stops
a malicious client having the MPC sign a transfer to themselves), and the
derivation path is the caller's identity commitment recomputed from the
secret-key witness, so it is not even an argument. The caller supplies only
what is genuinely theirs to choose: their account's nonce, the gas envelope
their account pays, and the MPC key version.

```compact
export circuit startDeposit(
  evmNonce: Uint<64>,
  gasLimit: Uint<64>,
  maxFeePerGas: Uint<128>,
  maxPriorityFeePerGas: Uint<128>,
  keyVersion: Uint<8>,
  depositRequest: DepositRequest  // { erc20Address: Bytes<20>, amount: Uint<128> }
): [] {
  // The request's derivation path IS the caller's identity commitment.
  const caller = disclose(userCommitment(callerSecretKey()));

  // Contract-enforced calldata: transfer(vaultEvmAddress, amount). The words
  // are ABI-ready (big-endian): the signer uses them verbatim.
  const calldata = EvmCalldata<2> {
    selector: Bytes [0xa9, 0x05, 0x9c, 0xbb], // transfer(address,uint256)
    noWords: 2 as Uint<16>,
    words: [
      evmAddressAbiWord(vaultEvmAddress),
      numericAbiWord(depositRequest.amount),
    ]
  };
  // ... assemble EvmType2TxParams for the deposit's ERC20 on the
  //     initialise-pinned chain, carrying no ETH ...

  const request = constructSignBidirectionalEvent<EvmType2TxParams<2, 0, 0>, 34, 34>(
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
  const requestId = disclose(calculateRequestId<EvmType2TxParams<2, 0, 0>, 34, 34>(request));

  // Store the request for the MPC to discover, plus the settle view
  // completeDeposit gates and mints from...
  signetRequestNonce.increment(1);
  depositEventMap.insert(requestId, disclose(request));
  depositSettleViews.insert(requestId, DepositSettleView {
    commitment: caller,
    erc20: disclose(depositRequest.erc20Address),
    amount: disclose(depositRequest.amount as Uint<64>),
  });

  // ...and notify it, carrying the map's ledger-tree path ([1,3] at depth 2,
  // Setup step 3).
  signetSigner.signBidirectional(
    requestId,
    constructSignBidirectionalEventNotificationV1(
      kernel.self(),
      2 as Uint<8>,                        // requestsPathDepth
      [1, 3, 0, 0] as Vector<4, Uint<8>>,  // requestsPath, zero padded
    ),
  );
}
```

Invoking it, and getting the request id every later step keys on:

```ts
import { JsonRpcProvider } from "ethers";
import { calculateRequestId, requestIdHex, SIGNET_DEFAULT_KEY_VERSION } from "@sig-net/midnight";

// The sweep sender is the user's deposit account: fetch its next nonce.
const evmNonce = await new JsonRpcProvider(evmRpcUrl).getTransactionCount(evmUserAddress);

await vault.callTx.startDeposit(
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

[`start-deposit.ts`](integration-tests/src/flows/start-deposit.ts) shows the full
`expectedRecord` reconstruction, byte for byte, and asserts the recomputed id
appears as a ledger map key after the call.

### Runtime step 2: poll for the MPC's signature

The MPC's signature response is emitted as a contract event carrying the
request id it answers. That id is unauthenticated routing data on an open
event log (anyone can post), so use the verifying getter: it only returns a
post whose signature recovers to the user's deposit account over the sweep's
signing hash:

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

const signedSweep = await reader.getSignedEvmTransaction(requestId, evmUserAddress);
await new JsonRpcProvider(evmRpcUrl).broadcastTransaction(signedSweep.serialized);
```

The ERC20 moves from the user's deposit account into the vault's account.
Flow function: [`broadcast-evm.ts`](integration-tests/src/flows/broadcast-evm.ts)
(idempotent: an already-mined sweep short-circuits cleanly, a reverted or
nonce-burned one throws).

### Runtime step 4: poll for the MPC's attestation

Once the MPC observes the mined execution it emits an ECDSA-signed
`RespondBidirectionalEvent`. The event carries the request id it answers and
the MPC's signature over the attestation digest
`upgradeFromTransient(transientHash([requestId, serializedOutput]))`. Neither the digest nor the
serialized output goes on chain: the client must reconstruct the exact bytes
the MPC hashed, in two moves, and then check the signature against them.

**Move 1: fetch the raw execution output.** This is the mined call's raw
EVM return data (for the sweep: the single ABI-encoded `bool` word that
`transfer` returned). Any source works, since the bytes stay untrusted
until the signature check below. With a node that has tracing enabled you can
trace the mined transaction via `debug_traceTransaction` (the same RPC
method the MPC itself uses to extract the output). On the local stack the fakenet
responder saves you that RPC access: it caches each request's traced output
and serves it over its public `/responses/{requestId}` helper API (port
3040). It caches before it posts the attestation, so once an event is
visible the fetch succeeds. Check the response's `success` flag: a reverted
or replaced transaction has no output to fetch at all, and the candidate to
hash is the protocol's fixed 5-byte failure output `0xdeadbeef01`.

**Move 2: re-pack it into the bytes the MPC hashed.** The MPC did not hash
the raw return data. It decoded the raw data per the request's
`outputDeserializationSchema`, then packed the decoded values per its
`respondSerializationSchema`, and hashed THAT. Run the same two conversions
(for the vault: the 32-byte ABI `bool` word in, the 1-byte packed result
out), and the posted signature verifies over the re-packed bytes only if the
MPC attested this outcome. With no digest on the event, that check is the
whole selection.

Everything stays UNTRUSTED here (the respond events are open to anyone, and
the helper API is unauthenticated): the authoritative check is the in-circuit
signature verification `completeDeposit` runs in step 5, against the same response key
the vault pinned at initialise.

```ts
import { deserializeEvmOutput, serializeRespondOutput } from "@sig-net/midnight";

// Move 1: the raw EVM return data of the mined sweep, here from the
// fakenet's /responses helper API. Unauthenticated, and any other source
// (e.g. your own trace RPC) works equally: the signature check below is what
// makes the bytes meaningful.
const response = await fetch(`http://localhost:3040/responses/${requestId}`);
const { success, output } = await response.json();
// success === false: nothing was returned to fetch (reverted/replaced tx).
// The candidate to check is then MPC_FAILURE_OUTPUT, not `output`.

// Move 2: raw return data -> the serialized output the MPC hashed. Decode
// per the output deserialization schema, re-pack per the respond
// serialization schema (the exact two conversions the responder ran):
// the 32-byte ABI bool word in, transfer()'s 1-byte packed result out.
const decoded = deserializeEvmOutput('[{"name":"success","type":"bool"}]', output);
const serializedOutput = serializeRespondOutput('[{"name":"success","type":"bool"}]', decoded);

// Signature verification selects WHICH posted event the MPC attested for
// these bytes. mpcResponseKey is the key the vault pinned at initialise,
// read back from its own ledger, so an accepted post is one that proves.
const attestation = await reader.getVerifiedRespondBidirectionalEvent(
  requestId,
  serializedOutput,
  mpcResponseKey,
);
// undefined: nothing attesting these bytes posted yet, poll again.
```

Flow functions:
[`poll-respond-bidirectional.ts`](integration-tests/src/flows/poll-respond-bidirectional.ts)
and [`respond-output.ts`](integration-tests/src/flows/respond-output.ts)
(which also handles the failure case: a reverted or replaced transaction is
attested as the protocol's fixed 5-byte failure output, `0xdeadbeef01`).

### Runtime step 5: `completeDeposit()` verifies and mints

The depositor presents the attestation AND the recomputed output bytes to
the vault, which re-hashes the bytes into the digest and verifies the
signature over it in-circuit, and
mints shielded vault tokens for the deposited amount, to the caller or to an
optional alternate recipient's coin public key:

```compact
export circuit completeDeposit(
  requestId: RequestId,
  respondBidirectionalEvent: RespondBidirectionalEvent,
  serializedOutput: Bytes<1>,  // the schema-packed EVM result at its exact width
  mintNonce: Bytes<32>,
  recipient: Maybe<Either<ZswapCoinPublicKey, ContractAddress>>,
): [] {
  // The EVM result at its exact packed width: one byte, transfer()'s bool.
  assert(serializedOutput as Field == 1 as Field, "ERC20 transfer returned false");

  // The only authentication gate: the attestation digest is recomputed here
  // from the presented output, and the event's ECDSA signature over it must
  // verify against the initialise-pinned response key.
  assert(
    verifyRespondBidirectionalEvent<1>(
      disclosedRequestId,
      serializedOutput,
      disclose(respondBidirectionalEvent),
      mpcResponseKey
    ),
    "Invalid attestation signature"
  );

  // Kind isolation + double-settle protection: only a pending DEPOSIT is in
  // this map, and settling consumes it.
  assert(depositEventMap.member(disclosedRequestId), "Deposit not found");
  depositEventMap.remove(disclosedRequestId);

  // Depositor gate: the caller's recomputed commitment must match the one
  // startDeposit pinned in the settle view.
  const view = depositSettleViews.lookup(disclosedRequestId);
  assert(userCommitment(callerSecretKey()) == view.commitment, "Not the depositor");
  depositSettleViews.remove(disclosedRequestId);

  // Mint shielded vault tokens for the amount the settle view carries, under
  // the token colour of the ERC20 it names. No ABI word is decoded here.
  mintShieldedToken(
    vaultTokenDomainSeparator(view.erc20),
    view.amount,
    disclose(mintNonce),
    claimRecipient
  );
}
```

Invoking it:

```ts
import { requestIdBytes } from "@sig-net/midnight";

// A fresh RANDOM mint nonce per settle: one derived from the (public) request
// id would let any observer link the minted coin to the deposit.
const mintNonce = crypto.getRandomValues(new Uint8Array(32));

// Mint to the caller's own wallet (recipient: none). Compact's Maybe/Either
// are plain structs, so a `none` still carries a default-valued payload.
await vault.callTx.completeDeposit(requestIdBytes(requestId), attestation, serializedOutput, mintNonce, {
  is_some: false,
  value: { is_left: true, left: { bytes: new Uint8Array(32) }, right: { bytes: new Uint8Array(32) } },
});
```

The deposited amount is in the caller's wallet as shielded vault tokens.
Flow function: [`complete-deposit.ts`](integration-tests/src/flows/complete-deposit.ts), including
how to mint to a different wallet's coin public key.

## Runtime: the other circuits

The remaining circuits reuse the `startDeposit` → `completeDeposit` shape. Below is only what
each one changes. Full code lives in the flow files under
[`integration-tests/src/flows/`](integration-tests/src/flows/).

### Withdraw (`startWithdraw` / `completeWithdraw` / `refundWithdraw`)

The same five steps with the roles swapped: the caller surrenders shielded vault
tokens up front, and the requested EVM transfer spends from the vault's own
account.

| | Deposit round trip | Withdraw round trip |
|---|---|---|
| Runtime step 1 | `startDeposit()` | `startWithdraw()`, which also takes (and burns) the surrendered coin |
| Derivation path → signer | The caller's identity commitment → the user's deposit account | `"vault"` → the vault's own account |
| Who pays the EVM gas | The user's account, caller-chosen envelope | The vault's account, contract-fixed envelope |
| Runtime step 2 `expectedSigner` | `evmUserAddress` | `evmVaultAddress = deriveEvmAddress(mpcRootPublicKey, vaultContractAddress, "vault")` |
| Runtime steps 3 and 4 | Identical mechanics | Identical mechanics |
| Runtime step 5 | `completeDeposit()`: depositor-only, mints on success | `completeWithdraw()`: open to anyone on success, withdrawer-only refund on a false return. `refundWithdraw()`: withdrawer-only refund when the transfer never executed |

Two patterns to take from it
([`start-withdraw.ts`](integration-tests/src/flows/start-withdraw.ts) /
[`complete-withdraw.ts`](integration-tests/src/flows/complete-withdraw.ts)):

- **Coin-spend as authorisation.** `startWithdraw()` is optimistic: the surrendered
  coin is BURNED first (`sendImmediateShielded` forwards its full value to the
  stdlib's `shieldedBurnAddress()`, so vault tokens are IOUs a refund
  re-mints), and the refund path exists for when the EVM leg later fails. The spend IS the auth, so anyone may
  withdraw to any destination. Because the vault's account pays the gas, the fee
  envelope is contract-FIXED (a caller-chosen cap would let anyone drain the
  vault's ETH). The request is keyed under the vault's own `"vault"` path so the
  MPC signs with the vault account, and a settle view carrying the withdrawer's
  refund commitment is pinned in `withdrawSettleViews` so only they can claim a
  refund.
- **The settle branches on the MPC-attested output, never the caller, and the
  output WIDTH routes the call.** An executed transfer's 1-byte packed bool settles
  through `completeWithdraw` (final on success, so anyone holding the attestation
  may settle it, withdrawer-only re-mint on a `0x00` false return). A transfer that
  never executed is attested as the protocol's fixed 5-byte failure output
  (`0xdeadbeef01`, `MPC_FAILURE_OUTPUT`) and can only type-fit `refundWithdraw`'s
  `Bytes<5>`. Refunds re-mint under a fresh nonce (unlinkable to the request), and
  the refund commitment is a DIFFERENT scheme from `userCommitment` (distinct
  domain + the request id) so a withdrawal's refund marker can't be linked to a
  depositor's identity.

### Swap (`approveRouter`, `startSwap` / `completeSwap`)

The swap leg has the vault trade its pooled ERC20s on Uniswap V3 as if it were an
EVM user. `approveRouter` is a **sign-only** request: one allowance per token,
contract-fixed spender and amount, and no settle circuit at all (a stale allowance
just makes the next swap revert and refund). `startSwap` reuses the optimistic
burn-then-mint shape on a SEPARATE request map at its own ledger field (the
calldata width is part of the ledger type), recording an `exactOutputSingle` on
the pinned router: it burns `amountInMaximum` of tokenIn up front and asserts
`amountOut ≤ Uint64` BEFORE the burn (so an oversized mint can never strand the
coin). `completeSwap` mints the exact `amountOut` of tokenOut plus the unspent
tokenIn as change (the attested `amountIn` spent, native-deserialized from a uint64
respond schema), and a swap that reverts settles through `refundSwap`. Flow
functions: [`approve-router.ts`](integration-tests/src/flows/approve-router.ts),
[`start-swap.ts`](integration-tests/src/flows/start-swap.ts),
[`complete-swap.ts`](integration-tests/src/flows/complete-swap.ts),
[`swap-round-trip.ts`](integration-tests/src/flows/swap-round-trip.ts).

# Package layout

| Package | What it is |
|---|---|
| [`contract/`](contract/) | The Compact contract (`src/erc20-vault.compact`), its witnesses, a curated environment-agnostic export surface, simulator unit tests, and a deploy entrypoint. Its dependency list (`@sig-net/midnight`, `@sig-net/midnight-contract` and the compact tooling) is the minimal integration surface. |
| [`integration-tests/`](integration-tests/) | The executable documentation: typed in-process flow functions (`src/flows/`) driving every runtime step above, the setup pipeline that deploys the whole stack, and eight e2e specs. The EVM leg runs against a Sepolia fork, so the flows use real USDC (and EURC for swaps) dealt to the derived accounts with anvil cheatcodes. |

# Running it

Everything runs from the repo root against the local docker stack (Midnight
node, indexer, proof server, anvil forking Sepolia, fakenet MPC responder).
The anvil service forks Sepolia so the real Uniswap V3 deployment and real
USDC are present, so `SEPOLIA_FORK_RPC_URL` (any Sepolia RPC) MUST be in
`.env` before the stack comes up. The fakenet responder's compose service
sits behind the `fakenet` profile, so a plain `docker compose up -d` does not
start it: the test setup starts it itself mid-run once the hand-off values are
in `.env`. Beyond `SEPOLIA_FORK_RPC_URL` the setup pipeline fills `.env`
itself, recording everything it deploys so that later runs reuse the same
contracts.

```sh
corepack enable
yarn install
cp .env.example .env                # then set SEPOLIA_FORK_RPC_URL to any Sepolia RPC
compact update 0.33.0-rc.2          # Exact version required.
yarn compile:erc20-vault:zk         # ~10 min zk key generation, background it
docker compose up -d                # node, indexer, proof server, anvil forking
                                    # Sepolia (NOT the fakenet responder: it is
                                    # behind the `fakenet` profile, the test setup
                                    # starts it mid-run)
yarn test:erc20-vault:e2e           # the eight e2e specs, serially, bail on first failure
```

Offline checks that need no stack and no proving keys beyond `yarn compile`:

```sh
yarn compile:erc20-vault            # generate src/managed (skip-zk)
yarn build                          # typecheck everything
yarn test:erc20-vault               # simulator unit tests + offline-skipped e2e files
```

Beware: rerunning plain `yarn compile` (or `yarn compile:erc20-vault`) after
a deploy regenerates `src/managed` WITHOUT proving keys, deleting the zk keys
directory the e2e suite proves with, so `yarn compile:erc20-vault:zk` is
required again before the next e2e run.

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

Eleven specs run serially in a pinned order (see
`integration-tests/vitest.config.ts`). `happy-day-e2e` runs first because it
initialises the vault and cycles the funds that the later flows build on.
Each spec is rerun-tolerant against kept contract addresses and prints resume
ids in banners as it goes, for recovering a run that died mid-flow.

| Spec | Tests | What it proves | Resume var(s) |
|---|---|---|---|
| `happy-day-e2e` | 15 | Full deposit + withdraw round trips, every leg asserted (incl. the MPC-convention reads a responder does) | `DEPOSIT_REQUEST_ID`, `WITHDRAW_REQUEST_ID` |
| `deposit-withdrawal-failure-refund` | 9 | A withdraw whose EVM transfer reverts ends in an in-circuit REFUND of the escrowed shielded value | `FAILURE_REFUND_DEPOSIT_REQUEST_ID`, `FAILURE_REFUND_WITHDRAW_REQUEST_ID` |
| `deposit-claimant-not-caller` | 6 | `completeDeposit` can direct the mint to a different wallet's coin public key, discovered from chain data alone | `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID` |
| `benchmark` | 43 | Per-leg wall-clock report covering every vault circuit: initialise (fresh deploys), approveRouter, startDeposit/completeDeposit, startWithdraw/completeWithdraw, startSwap/completeSwap, approveStata, startSupply/completeSupply, startRedeem/completeRedeem, and forced-revert refunds (`BENCHMARK_TIMINGS_JSON` greppable line) | `BENCHMARK_DEPOSIT_REQUEST_ID`, `BENCHMARK_WITHDRAW_REQUEST_ID`, `BENCHMARK_SWAP_REQUEST_ID`, `BENCHMARK_SUPPLY_REQUEST_ID`, `BENCHMARK_REDEEM_REQUEST_ID`, `BENCHMARK_REFUND_DEPOSIT_REQUEST_ID`, `BENCHMARK_REFUND_WITHDRAW_REQUEST_ID` |
| `false-claimer` | 6 | A deposit recorded for identity A is NOT claimable by identity B, even with the valid MPC attestation | `FALSE_CLAIMER_DEPOSIT_REQUEST_ID` |
| `bearer-transfer` | 11 | Shielded vault tokens are bearer assets: a plain Midnight transfer hands the claim to wallet B, the emptied wallet A cannot withdraw, and B completes a full withdraw on the transferred balance | `BEARER_TRANSFER_DEPOSIT_REQUEST_ID`, `BEARER_TRANSFER_WITHDRAW_REQUEST_ID` |
| `swap-e2e` | 1 | A deposit-funded `exactOutputSingle` swap mints exactly the requested `amountOut` of tokenOut plus the unspent tokenIn as change | none |
| `supply-redeem-e2e` | 1 | A deposit-funded Aave supply mints the attested stataUSDC shares, and redeeming them mints back the attested USDC (principal + interest) | none |
| `supply-refund-e2e` | 1 | A supply whose wrapper deposit reverts on-chain (drained vault balance) ends in an in-circuit REFUND of the surrendered USDC | none |
| `swap-refund-e2e` | 1 | A swap whose `amountInMaximum` is below the real cost reverts on-chain and the settle re-mints the surrendered tokenIn | none |
| `redeem-refund-e2e` | 1 | A redeem whose wrapper burn reverts on-chain (drained vault stataUSDC balance) ends in an in-circuit REFUND of the surrendered shares | none |

95 tests total (the swap and aave specs, and the benchmark's swap/aave legs,
self-skip when the EVM chain lacks the Uniswap router or the stataUSDC
wrapper, e.g. an un-forked anvil; in CI the aave gate specs fail instead of
skipping). A rerun
against kept contract addresses (a populated `.env`)
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
   request, not a fresh deposit:

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
