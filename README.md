# Midnight Contracts Calling Foreign Chains with Sig Network

This monorepo holds experimental example projects. Midnight contracts that
execute arbitrary transactions on foreign blockchains through the Sig Network
[Distributed MPC](https://github.com/sig-net/mpc). Every example integrates the
Sig Network [Sign Bidirectional Flow](#sign-bidirectional-flow), and is built on
[`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight),
the Sig Network protocol library.

Start with the [Sign Bidirectional Flow](#sign-bidirectional-flow) for what the
protocol does, the [Examples](#examples) for a worked application of it, or the
[Integration guide](#integration-guide) to wire it into your own contract.

> ## ⚠️ CAUTION ⚠️
>
> These are example applications for educational and experimental purposes.
> Use at your own risk and expect rapid iteration.

## Examples

Each example is a directory under [`examples/`](examples/) holding a `contract` package and an `integration-tests` package.

| Example | What it demonstrates | Flow walkthroughs |
|---|---|---|
| [ERC20 Vault](examples/erc20-vault/README.md) | A Midnight vault holding ERC20 tokens on an EVM chain: private deposits into MPC-derived accounts, withdrawals, Uniswap swaps and Aave supply/redeem, all driven through the sign bidirectional flow. | [deposit](examples/erc20-vault/docs/deposit/deposit.md), [withdraw](examples/erc20-vault/docs/withdraw/withdraw.md), [swap](examples/erc20-vault/docs/swap/swap.md), [supply](examples/erc20-vault/docs/supply/supply.md), [redeem](examples/erc20-vault/docs/redeem/redeem.md) |

## Sign Bidirectional Flow

The flow brings foreign blockchain assets and functionality to a contract on
Midnight: the contract records a signature request, the MPC network signs it,
the dApp relays the signed transaction to the foreign chain, and the MPC attests
the execution outcome back to Midnight, where the contract verifies that
attestation in-circuit.

![Sign bidirectional flow](docs/sign-bidirectional-flow.drawio.png)

The diagram numbers the five steps:

1. **The contract records a request.** A user interacts with the integrating
   dApp, which calls a circuit on the integrating client contract
   (`startCrossChain(...)` in the diagram). The circuit stores a
   `SignBidirectionalEvent` in its own `signBidirectionalEventMap`: the request
   carries the fields of the transaction destined for the foreign chain, plus
   the path the MPC derives the signing key from. The circuit then notifies the
   MPC with a cross-contract call to `signBidirectional(...)` on the Sig Network
   Singleton Contract, which emits a `SignBidirectionalEventNotification`.
2. **The MPC signs.** Watching the singleton's events, the MPC follows the
   notification to the request stored in the client contract's state, builds the
   foreign transaction and signs it with the request signing key derived for
   that contract and path. It posts the signature back to Midnight by calling
   `respond(...)` on the singleton, which emits a `SignatureRespondedEvent`.
3. **The dApp broadcasts.** The dApp polls the singleton's events, verifies the
   posted signature, assembles the fully signed transaction and, acting as the
   relayer, submits it to the foreign chain. The MPC only ever signs, so
   broadcasting is the dApp's responsibility.
4. **The MPC attests the outcome.** Watching the foreign chain, the MPC observes
   the transaction execute, serialises the execution output per the request's
   respond schema, and signs the attestation digest
   `keccak256(requestId || serializedOutput)` with the response key derived for
   that contract. It posts the attestation by calling `respondBidirectional(...)`
   on the singleton, which emits a `RespondBidirectionalEvent`. Neither the
   digest nor the output itself travels on chain.
5. **The contract settles.** The dApp recovers the execution output off chain
   (it broadcast the transaction in step 3, so it can read the result), takes the
   attestation from the emitted event and submits both to a settling circuit
   (`completeCrossChain(...)` in the diagram). That circuit recomputes the digest
   from the output bytes and verifies the MPC's signature in-circuit against the
   response key the contract pinned after deploy, completing the cross chain
   interaction.

Both keys the flow uses, the request signing key of step 2 and the response key
of steps 4 and 5, are derived from the MPC root key scoped by the requesting
contract's address, so no contract can reach another contract's keys. For the
full protocol depth (both key derivations, each event's payload, how a failed
foreign transaction is attested, and how the client recovers the execution
output) read
[Sign Bidirectional Flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-flow)
in the integration repository.

## Integration guide

Integrating a contract on Midnight with the Sig Network MPC is 4 once-off setup
steps and 5 per-request runtime steps. In setup, you add `@sig-net/midnight` and
import its Signet Compact module, declare the protocol state in your ledger (the
`signBidirectionalEventMap` your requests live in, the `SignetSigner` singleton
reference your circuits notify, and your contract's own `mpcResponseKey`), then
pin that response key right after deploy through a deployer-gated one-shot
circuit: its derivation takes the contract's address as input, which exists only
once the contract is deployed. At runtime, steps 1 and 5 of the flow above are
circuits on your contract, and the three middle steps are off-chain client code
built on the readers and helpers in `@sig-net/midnight`.

The full guide, with the Compact and TypeScript for each of those steps, is
[Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide)
in the integration repository. It also carries the two rule sets a first
integration trips over: how to read your request map's ledger-tree path out of
the compiled artifacts, and how EVM Type 2 calldata words must be built and read
back. Every example here is a worked application of that guide, closest to the
code in the [ERC20 vault](examples/erc20-vault/README.md).

The protocol packages the examples integrate against, all developed in
[sig-net/midnight-integration](https://github.com/sig-net/midnight-integration):

- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the
  client-agnostic protocol library (the shared Compact modules, state readers,
  event decoders, request feed and crypto helpers).
- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract):
  the central Signet singleton contract.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy):
  deploy tooling for that contract plus generic Midnight deploy and wallet
  plumbing.

## Contributor guide

There are two test layers. Unit tests run offline against a simulated Midnight
runtime: no docker stack, no zk keys, seconds not minutes. The end to end
integration suites drive the full protocol against the local docker stack and
the fakenet MPC responder, and take minutes.

Everything runs from the repository root. Only contract packages have a compile
step, and `build`, `test` and `lint` all read the compiler's generated
`src/managed/` output, so compile first:

```sh
yarn install         # from the root, never from inside a workspace member
yarn compile         # compact compiler per contract package, without zk keys
yarn compile:zk      # with zk keys: needed for deploys and the e2e suites only
yarn build           # typecheck every package
yarn test            # unit tests: offline, simulator only
yarn format:check    # prettier check. `yarn format` rewrites
yarn lint            # eslint, type-aware. `yarn lint:fix` applies the autofixes
```

Scripts targeting one example carry that example's directory name:
`yarn compile:erc20-vault`, `yarn compile:erc20-vault:zk`,
`yarn test:erc20-vault` and `yarn build:erc20-vault`. ESLint and Prettier are
configured once at the repo root and cover every member, and each example's CI
workflow runs `yarn format:check` and `yarn lint` before its tests, so
formatting drift or a lint finding fails the build.

The e2e suites need the docker stack running and the fakenet MPC responder, and
they also run from the root:

```sh
yarn test:erc20-vault:e2e                              # every spec in the suite
yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts  # one spec file
```

Getting there from a fresh clone (the `.env` file and its Sepolia fork RPC, the
zk keys, bringing the stack up, what a green first run looks like, and recovering
a run the proof server was OOM-killed in) is walked end to end in the example's
own README: [examples/erc20-vault/README.md](examples/erc20-vault/README.md).

## Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node. The repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2, invoked with `--feature-zkir-v3` (see note) | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/example-test.yaml](.github/workflows/example-test.yaml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine, with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop, plugin package on Linux |

**NOTE:** every `compact compile` against this stack must pass the
`--feature-zkir-v3` flag: it is part of the pinned ledger-9 matched set
(compiler, node, indexer, proof server), and output compiled without it is not
compatible with that stack. This repository's compile scripts already pass it.
Integrators compiling their own contracts must pass it themselves, as shown in
the [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide).

**NOTE:** the midnight proof server is quite heavy. Allocate at least 16 GB of
RAM to your docker environment, otherwise expect to restart the tests multiple
times as the proof server hangs.

## Repository layout

A yarn workspace split at the top level between shared machinery (`packages/`)
and the examples integrators read and copy (`examples/`). An example's
`contract` package depends on the Signature Network SDK and the compact tooling
and nothing else, so its dependency list is itself documentation of the minimal
integration surface.

```
├── README.md               # this file
├── AGENTS.md               # workspace rules for agents and humans (CLAUDE.md points here)
├── docker-compose.yaml     # example-agnostic local stack: Midnight node, indexer,
│                           #   proof server, anvil EVM forking Sepolia, fakenet MPC responder
├── .env.example            # every variable the stack and the suites read, documented
├── drawio.config.json      # render settings for every diagram in the repo
│
├── .github/workflows/      # the reusable example-test workflow, one thin caller
│                           #   per example, and a workflow linter
│
├── docs/                   # the shared diagram system: style guide, palette, icon bank,
│                           #   and the generic protocol diagram embedded above
│
├── packages/               # shared machinery, kept ruthlessly small
│   ├── lib/                # @midnight-examples/lib: runtime helpers examples import
│   └── test-harness/       # @midnight-examples/test-harness: test-only machinery
│                           #   (stack bring-up, wallet funding, env/session handling)
│
└── examples/               # the things integrators read and copy
    └── erc20-vault/        # see examples/erc20-vault/README.md
        ├── contract/       # the Compact contract, its witnesses, the curated
        │                   #   export surface, simulator unit tests and a deploy entrypoint
        ├── integration-tests/  # typed flow functions, tsx entrypoints over them, e2e specs
        └── docs/           # the example's actor map, plus one folder per flow
```
