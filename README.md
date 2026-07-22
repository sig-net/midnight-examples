# Midnight Contracts Calling Foreign Chains with Sig Network

This monorepo contains experimental example projects demonstrating Midnight contracts leveraging the Sig Network [Distributed MPC](https://github.com/sig-net/mpc) to execute arbitrary transactions on foreign blockchains.

They show how builders can integrate with the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to bring functionality on foreign blockchains to their contracts on Midnight. The examples are built on [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight), the client-agnostic signet protocol library, and each example's `contract` package demonstrates the minimal dependencies an integrator needs.

Jump to the [Quickstart](#quickstart) to get an example running, read the [Integrator Guide](#integrator-guide) to wire the protocol into your own contract, or start at [Repository Layout](#repository-layout) to gain a deeper understanding of what you can find in this repository.

> ## ⚠️ CAUTION ⚠️
>
> Thes are example applications for educational and experimental purposes.
> Use at your own risk and expect rapid iteration.

# Sign Bidirectional Flow

The flow comprises 5 steps:

1. Client calls a contract on Midnight which requests a signature for a transaction destined for a foreign chain. The signature is made with a key derived for the requesting contract (see [Derived keys](#derived-keys)).
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight.
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain.
4. Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight.
5. Client extracts the signed foreign execution output and submits it back to the Midnight contract, which verifies the MPC's signature over it in-circuit against the contract's own response key (see [Derived keys](#derived-keys)), completing the foreign transaction execution.

## Derived keys

Every key the MPC uses is derived for the requesting contract and a path. There are two kinds: the request signing key, whose path each contract chooses, and the response signing key, whose path is fixed by the protocol. Both key derivations are **scoped by the address** of the requesting contract.

### Request signing key

The key the MPC signs requested foreign transactions with:

`requestSigningKey = f(mpcRootKey[keyVersion], contractAddress, path)`

The path is 32 opaque bytes of the contract's choosing (e.g. a fixed literal for a contract-owned account like "vault", or a hash of a caller's secret for per-user accounts). There are no format requirements. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

### Response key

The key the MPC signs foreign execution outputs with when posting them back to Midnight:

`responseKey = f(mpcRootKey[keyVersion], contractAddress, "midnight response key")`

The same derivation, but with the path fixed to the literal `"midnight response key"`, giving each contract one well-known response key. A contract pins its own response key in its ledger after deploy and verifies every response against it in-circuit (step 5 of the flow above).

# Quickstart

The quickest way to get going with these examples is to get an end to end integration test for one of them running locally. We recommend you start with the erc20-vault happy day test.

1. Ensure you have all of the [prerequisites](#prerequisites) installed.
2. From the repository root, install workspace dependencies and select the required Compact toolchain explicitly:
   ```sh
   corepack enable
   yarn install
   compact update 0.33.0-rc.2   # Exact version required.
                                # `compact update` installs/downgrades
                                # to stable.
   ```
3. Start the local stack (Midnight node, indexer, proof server, anvil EVM, fakenet MPC responder) with `docker compose up -d`.
4. Run the happy day test and watch it go. The first run can take **~20–25 minutes** (it generates zk proving keys, deploys every contract and funds the derived accounts, all automatically, no `.env` inserts needed):
   ```sh
   yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts

   # Optional: Run with 'step-through' enabled to pause test at each step
   # to make it a little easier to follow along with everything that is happening.
   STEP_THROUGH=1 yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts
   ```
   Green looks like `Tests  15 passed (15)`. Afterwards, paste the setup's printed `.env` block into `.env` so the next run reuses the deployed contracts (~3–4 minutes).

**TIP:** If you are using Claude Code you can ask it to do all of this for you using this [skill](.claude/skills/e2e/SKILL.md), for example:
```
Use your /e2e skill to get the erc20-vault happy day test running for me, from fresh clone to green. Recover the run yourself if anything fails along the way.
```

**NOTE:** The most common reason that the run fails is as a result of the proof server hanging or crashing when it exhausts memory on a proving leg. This happens routinely, even on a Docker VM with 16 GB of RAM (the heavy claim/settle proofs peak above 12 GiB). This most often presents as the test failing with `connect ECONNREFUSED 127.0.0.1:6300` partway through a claim or settle step, with `docker ps -a` showing the `midnight-proof-server` container as `Exited (137)`, i.e. OOM-killed. If this happens it is usually possible to restart the proof server and pick up the test run at the last successful chain interaction instead of starting over, using variables printed out in banners as the test progresses. See [test run recovery](./examples/erc20-vault/README.md#test-run-recovery) in the erc20-vault integration testing package for more details.

# Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node. The repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2, invoked with `--feature-zkir-v3` (see note) | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/example-test.yaml](.github/workflows/example-test.yaml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine, with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop, plugin package on Linux |

**NOTE:** every `compact compile` against this stack must pass the `--feature-zkir-v3` flag: it is part of the pinned ledger-9 matched set (compiler, node, indexer, proof server), and output compiled without it is not compatible with that stack. This repository's compile scripts already pass it. Integrators compiling their own contracts must pass it themselves (as shown in the [Integrator Guide](#integrator-guide)).

**NOTE:** the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of RAM to your docker environment, otherwise expect to have to restart the tests multiple times as the proof server hangs.

# Running against Sepolia

By default the EVM leg runs on the local anvil dev chain from `docker-compose.yaml`. To point it at Sepolia instead, only the EVM side changes: the Midnight stack and the fakenet MPC responder stay local. Minimal changes, all in `.env`:

```sh
# Both must point at the SAME chain: the tests' endpoint and the responder's
# container-side twin (an Infura/Alchemy/etc. Sepolia RPC URL works for both):
EVM_RPC_URL=https://sepolia.infura.io/v3/<your-key>
FAKENET_EVM_RPC_URL=https://sepolia.infura.io/v3/<your-key>

# Required on any non-local chain: an existing ERC20
# with code on Sepolia, e.g. a test USDC deployment.
ERC20_ADDRESS=0x...
```

Then recreate the responder so it re-reads `.env` (`docker compose --profile fakenet up -d --force-recreate fakenet`) and run the test as usual. The chain id (11155111) is resolved from the RPC automatically and sealed into the vault contract at initialize.

What does NOT happen automatically on a real chain, by design:

- **No auto-funding.** The flows spend from two EVM accounts *derived from the vault contract's address*, so you only learn them mid-run, when setup prints `EVM_VAULT_ADDRESS` / `EVM_USER_ADDRESS` with funding hints (the user account needs ≥ 0.01 ETH for gas and ≥ 0.1 USDC, and the vault account needs ETH for withdrawal gas). Fund them when printed, either across two runs (first run derives + prints, second run tests), or in one attended run with `STEP_THROUGH` (below).
- **No token deploy.** TestUSDC auto-deploys on the local chain only. On Sepolia you bring your own `ERC20_ADDRESS`.
- A redeploy of the vault contract derives **new** accounts: previously funded ones don't move with it.

## Watching a run step by step: `STEP_THROUGH=1`

```sh
STEP_THROUGH=1 yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts
```

pauses before every setup step and every test (after the first) until you press Enter, and each pause names the step about to run. Recommended for seeing exactly how the sign-bidirectional flow unfolds, and **specifically recommended on Sepolia with Infura**: you can fund the derived accounts the moment they're printed (completing everything in one run), watch each transaction confirm on Etherscan before releasing the next leg, and avoid bursts against Infura rate limits. Attended runs only: it waits on stdin forever, so never set it in CI or an unattended/backgrounded run.

# Integrator Guide

Each example application under [`examples/`](examples/) shows a concrete application of the integration guidelines in this section.

Integrating a contract on Midnight with the Sig Network MPC consists of:

- 4 once-off **setup** steps
- 5 per-request **runtime** steps that drive the full sign bidirectional flow

## Setup

1. Add the protocol library to your project:

   ```sh
   yarn add @sig-net/midnight   # or: npm install @sig-net/midnight
   ```

2. Import the Signet module at the top of your contract (resolved through `node_modules` via `COMPACT_PATH`):

   ```compact
   import "@sig-net/midnight/src/Signet";
   ```

   Then tell the compact compiler about the npm packages with its `COMPACT_PATH` environment variable at compile time:

   ```sh
   COMPACT_PATH=node_modules compact compile --feature-zkir-v3 src/my-contract.compact src/managed/my-contract
   ```

   The Compact toolchain requirements in [Prerequisites](#prerequisites) apply: compile with the pinned compiler version and always pass `--feature-zkir-v3`, as above.

3. Declare the required Sig Network protocol state in your ledger (plus recommended deployer identity and initialisation state). The event map can sit at ANY ledger field: each notification your contract registers names the field position holding it (runtime step 1), and the MPC reads the authenticated request from there.

   ```compact
   // Required: Map of SignBidirectionalEvent signature requests, configured by transaction type.
   // Configured and sized here for an EVM Type 2 transaction with
   // <1 calldata word, 0 access-list entries, 0 storage keys> and
   // 34-byte serialisation schemas.
   export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EVMType2TxParams<1, 0, 0>, 34, 34>;

   // Required: The Signet singleton signer interface, set at deploy.
   // Used to notify the MPC of events you add to your signBidirectionalEventMap.
   sealed ledger signetSigner: SignetSigner;

   // Required: This contract's MPC response key, set in step 4.
   // Used to verify RespondBidirectionalEvents containing the serialised output of foreign chain execution.
   export ledger mpcResponseKey: Secp256k1Point;

   // Recommended: contract-local source of request nonces, so identical
   // requests hash to distinct request ids. Nothing off-chain reads it.
   export ledger signetRequestNonce: Counter;

   // Recommended: used in step 4 to ensure initialisation runs only once.
   export ledger initialised: Counter;

   // Recommended: set on deploy, used in step 4 to ensure only the deployer may set the mpcResponseKey.
   sealed ledger deployer: Bytes<32>;

   // Recommended: supplies the deployer's identity secret from private state
   // off-chain; only its commitment (below) ever reaches the ledger.
   witness witnessDeployerSecretKey(): Bytes<32>;

   // Recommended: the deployer identity commitment scheme. Exported so deploy
   // tooling can compute the constructor argument by calling the compiled circuit.
   export pure circuit calculateDeployerCommitment(sk: Bytes<32>): Bytes<32> {
     return persistentHash<Vector<2, Bytes<32>>>([pad(32, "my-contract:deployer:"), sk]);
   }

   // Required: set signet contract and (recommended) deployer commitment on deployment.
   constructor(signetContract: SignetSigner, deployerCommitment: Bytes<32>) {
     signetSigner = disclose(signetContract);
     deployer = disclose(deployerCommitment);
   }
   ```

4. Set the contract's MPC response key once, right after deploy. Deriving this key requires the address of the contract, which only exists after deploy (see [Response key](#response-key)):

   ```compact
   export circuit initialise(responseKey: Secp256k1Point): [] {
     // Recommended: confirm that only the deployer may initialise, and only once:
     assert(deployer == calculateDeployerCommitment(witnessDeployerSecretKey()), "Not the deployer");
     assert(initialised == 0, "Already initialised");
     initialised.increment(1);

     // Required: set MPC response key for verification of RespondBidirectionalEvents
     mpcResponseKey = disclose(responseKey);
   }
   ```

## Runtime

Each interaction with your contract that executes a transaction on a foreign chain runs these 5 steps.

Steps 1 and 5 are circuits on your contract, and steps 2 to 4 are off-chain client code built on the utilities in `@sig-net/midnight`.

The off-chain steps share one `SignetRequestResponseReader` over your contract / Signet singleton pair, and the expected signer of the requested transaction (the key the MPC derives for your contract and the request's path, see [Derived keys](#derived-keys)):

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { deriveEvmAddress, SignetRequestResponseReader } from "@sig-net/midnight";

// SignetRequestResponseReader to poll for Signed Transactions and Signed RespondBidirectionalEvents
const reader = new SignetRequestResponseReader({
   // Address of YOUR deployed contract
   requesterContractAddress: myContractAddress,

   // signBidirectionalEventMap's field position (Setup step 3)
   requesterRequestsIndexField: 0,

   // Address of the Signet singleton contract
   signetContractAddress,

   // Provider to index Midnight Blockchain
   publicDataProvider: indexerPublicDataProvider({
      queryURL: indexerUrl,
      subscriptionURL: indexerWsUrl
   }),
});

const expectedSigner = deriveEvmAddress(mpcRootPublicKey, myContractAddress, "my-path");
```

1. Store a signature request and notify the MPC via cross contract call. Build (or overwrite) every part of the transaction your contract enforces in-circuit, calldata above all (see [EVM Type 2 Transactions and ABI Calldata Words](#evm-type-2-transactions-and-abi-calldata-words)), and never pass caller input through unchecked:

   ```compact
   // Construct SignBidirectionalEvent signature request and calculate its RequestId
   const request = constructSignBidirectionalEvent<EVMType2TxParams<1, 0, 0>, 34, 34>(/* ... */);
   const requestId = disclose(calculateRequestId<EVMType2TxParams<1, 0, 0>, 34, 34>(request));

   // Store the signature request in your signBidirectionalEventMap for MPC to discover
   signetRequestNonce.increment(1);
   signBidirectionalEventMap.insert(requestId, disclose(request));

   // Notify the MPC of the SignBidirectionalEvent and the location of your signBidirectionalEventMap.
   // The location is 0 here based on the position of the declaration in Setup step 3.
   signetSigner.signBidirectionalEvent(
      requestId,
      constructSignBidirectionalEventNotificationV1(kernel.self(), 0 as Uint<8>),
   );
   ```

   **NOTE:** `requestId` should be returned from the above circuit call so that it may be used in subsequent steps (or compute it off-chain with the `calculateRequestId` TS twin).

2. Poll the Signet singleton for the MPC's signature response. The response log is unauthenticated (anyone can post), so use the verifying getter: it only returns a post whose signature recovers to `expectedSigner` over the requested transaction's signing hash:

   ```ts
   const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
   // verified === undefined: no valid response posted yet, poll again.
   ```

3. Construct the signed transaction and submit it to the foreign chain. The reader rebuilds the transaction from the request record on your ledger and attaches the verified MPC signature:

   ```ts
   import { JsonRpcProvider } from "ethers";

   const signedTx = await reader.getSignedEVMTransaction(requestId, expectedSigner);
   await new JsonRpcProvider(foreignChainRpcUrl).broadcastTransaction(signedTx.serialized);
   ```

4. Poll the Signet singleton for the MPC's signed remote execution output (posted once the MPC observes the transaction execute on the foreign chain). Posts are stored unverified, so treat them as candidates: the authoritative check is your contract's verify circuit in step 5:

   ```ts
   const [respondBidirectionalEvent] = await reader.getRespondBidirectionalEvents(requestId);
   // Empty array: not posted yet, poll again.
   ```

5. Deliver the response to your contract, which verifies it in-circuit against the response key pinned in Setup step 4 and consumes the request:

   ```compact
   assert(
      verifyRespondBidirectionalEvent(requestId, respondBidirectionalEvent, mpcResponseKey),
      "Invalid attestation signature"
   );
   signBidirectionalEventMap.remove(requestId);
   ```

# EVM Type 2 Transactions and ABI Calldata Words

An `EVMType2TxParams` request decomposes the EVM transaction into typed fields your contract can enforce field by field in-circuit. Its optional `calldata` is an `EVMCalldata<maxWords>`: the 4-byte function selector plus a list of 32-byte ABI words, per the [Solidity ABI spec](https://docs.soliditylang.org/en/latest/abi-spec.html). Slots past `noWords` are unused capacity and never reach the transaction.

Every word must be stored in canonical ABI form (big-endian). The MPC signs a transaction whose calldata is exactly `selector || words[0..noWords]`, byte for byte, so a word stored in any other form becomes a signed transaction calling the foreign contract with garbage arguments. Compact's integer casts are little-endian, so do not hand-roll the byte order: build every word with the helper circuits the Signet module exports, and read words back with the matching readers.

| Solidity type | Build with | Read back with |
|---|---|---|
| `address` | `evmAddressAbiWord(addr: Bytes<20>)` | |
| unsigned integers up to `uint128` (amounts, ids) | `numericAbiWord(value: Uint<128>)` | `abiWordToUint128(word)` |
| `bool` | `boolAbiWord(value: Boolean)` | `abiWordToBool(word)` |

## Example: an ERC20 transfer

`transfer(address,uint256)`, selector `0xa9059cbb`, takes an address word and a numeric word. This is exactly how the erc20-vault contract builds its deposit and withdrawal calldata:

```compact
const calldata = EVMCalldata<2> {
  selector: Bytes[0xa9, 0x05, 0x9c, 0xbb],
  noWords: 2 as Uint<16>,
  words: [
    evmAddressAbiWord(recipient),  // address argument (Bytes<20>)
    numericAbiWord(amount)         // uint256 argument (from a Uint<128>)
  ]
};
```

## Example: a bool argument, and decoding a bool result

`setApprovalForAll(address,bool)`, selector `0xa22cb465`:

```compact
const calldata = EVMCalldata<2> {
  selector: Bytes[0xa2, 0x2c, 0xb4, 0x65],
  noWords: 2 as Uint<16>,
  words: [
    evmAddressAbiWord(operator),
    boolAbiWord(true)
  ]
};
```

The readers run the same rules in the other direction, rejecting any non-canonical word instead of silently truncating or coercing it. A `RespondBidirectionalEvent`'s `serializedOutput` is the ABI-encoded return data of the remote call, so a settle circuit can decode an ERC20 `transfer`'s `bool` return from the first output word:

```compact
const success = abiWordToBool(slice<32>(respondBidirectionalEvent.serializedOutput, 0));
assert(success, "Remote transfer failed");
```

The same builders and readers exist in `@sig-net/midnight` as TypeScript twins under identical names, for composing expected words off-chain (UIs, expected-record builders, tests).

# Repository Layout

This repository is structured as a yarn monorepo, split at the top level between shared utilities (`packages/`) and examples for integrators (`examples/`).

Each example is a directory under `examples/` containing 1–2 workspace packages: `contract` is **required**, `integration-tests` is added as required.

The `contract` package's dependency list demonstrates minimal Signature Network SDK & compact tooling dependencies that an integrator requires.

```
├── README.md                   # This README!
├── AGENTS.md                   # Non-negotiable workspace rules for agents & humans.
├── CLAUDE.md                   # Points at AGENTS.md.
├── package.json                # workspaces: ["packages/*", "examples/*/*"]
├── tsconfig.base.json          # Shared no-emit TS config; every package extends this.
├── docker-compose.yaml         # Example-agnostic local stack: midnight node + indexer +
│                               #   proof server, anvil EVM, fakenet MPC server.
├── .env.example
│
├── .github/
│   └── workflows/
│       ├── example-test.yaml       # Reusable workflow (workflow_call), parameterized by example
│       │                           #   dir: install → compact update → compile:zk (cached) →
│       │                           #   compose up → unit + integration tests.
│       ├── erc20-vault.yaml        # Thin caller (~10 lines): paths-filter on
│       │                           #   examples/erc20-vault/**, packages/**, compose file and
│       │                           #   the reusable workflow itself, then one `uses:` call.
│       └── other-example.yaml      # One thin caller per example.
│
├── packages/                   # Shared utilities for repository.
│   ├── lib/                    # @midnight-examples/lib
│   │   ├── package.json        # Runtime helpers imported by examples
│   │   ├── tsconfig.json       #   (wallet, providers, tx build & submit).
│   │   └── src/
│   │       └── index.ts
│   │
│   └── test-harness/           # @midnight-examples/test-harness
│       ├── package.json        # Test-only utilities: stack bring-up/teardown, mpc-keys setup,
│       ├── tsconfig.json       #   wallet funding, env/session handling, subprocess helpers,
│       └── src/                #   hardhat helpers.
│           └── index.ts
│
└── examples/                   # The things integrators read and copy.
    ├── erc20-vault/
    │   ├── README.md           # Demonstration of bridging ERC20 assets from an EVM to Shielded UTXOs on midnight.
    │   ├── contract/           # @midnight-examples/erc20-vault-contract
    │   │   ├── package.json        # Deps: @sig-net/midnight (npm) + compact tooling.
    │   │   ├── tsconfig.json
    │   │   ├── .gitignore          # src/managed/ (generated artifacts not committed, cached in CI)
    │   │   ├── deploy.ts           # Deploy script: constructor args & witness integration live here;
    │   │   │                       #   generic wallet & tx plumbing from @midnight-examples/lib.
    │   │   ├── src/
    │   │   │   ├── erc20-vault.compact # KEY: Contract demonstrating integration with Signature Network.
    │   │   │   ├── witnesses.ts        # Handwritten witnesses construction helpers.
    │   │   │   ├── managed/            # Contract artifacts generated by compactc, gitignored.
    │   │   │   └── index.ts            # Curated export surface, i.e. the "SDK" surface of the erc20
    │   │   │                           #   vault. Environment-agnostic: browser or backend, unchanged.
    │   │   └── tests/
    │   │       ├── erc20-vault.test.ts # Simulator-level unit tests that require no network.
    │   │       └── deploy.test.ts      # Builds a deploy tx from the real managed output (needs compile:zk).
    │   │
    │   └── integration-tests/  # @midnight-examples/erc20-vault-integration-tests
    │       ├── src/
    │       │   └── flows/      # Example-specific typed flow functions (deposit, withdraw, …):
    │       │                   #   the executable documentation of the example. All generic
    │       │                   #   setup comes from @midnight-examples/test-harness.
    │       ├── scripts/        # Thin tsx entrypoints over src/flows (deposit.ts, claim.ts, …)
    │       │                   #   for hand-driving a live stack step by step.
    │       └── tests/
    │           └── happy-day-e2e.test.ts   # Runs the flows in-process against the local stack.
    │
    └── other-example/          # Minimal examples may be contract-only with simulator tests.
        └── contract/
```

# Related Packages and Repositories

- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic signet protocol library the examples integrate against (shared Compact modules, state readers, request feed/resolver, crypto helpers).
- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central Signet singleton contract.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.
- [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration): where the protocol library and singleton contract are developed.
