# Midnight Contracts Calling Foreign Chains with Sig Network

These examples demonstrate Midnight contracts leveraging the Sig Network [Distributed MPC](https://github.com/sig-net/mpc) to execute arbitrary transactions on foreign blockchains.

They show how builders can integrate with the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to bring functionality on foreign blockchains to their contracts on Midnight. 

The **Sign Bidirectional Flow** comprises of 5 Steps:
1. Client calls a Contract on Midnight which requests a signature for a transaction destined for a foreign chain
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain
4. Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight
5. Client extracts the signed foreign execution output, then submits it back to the Midnight contract completing the foreign transacttion execution.

Jump to the [Quickstart](#quikstart) to get going or start reading at [Repository Layout](#repository-layout) to gain a deeper understanding of what you can find in this repository.

# Quikstart

The quickest way to get going with these examples is to get an end to end integration test for one of them running locally. We reccommend you start with the erc20-vault happy day test.

1. Ensure you have all of the [prequisites](#prerequisites) installed
2. Install workspace dependencies with `yarn install` from the repository root
3. Start a local Midnight Blockchain Stack with `docker compose up -d`
4. Run an integration test with: `yarn test:erc20-vault:e2e`

# Prerequisites

| Prerequisite | Version |Check With| Where to Get It|
| ------- | ------| ------  |----------- |
| Node     | >20   |???| ??? ???|
| Compact Compiler |0.33.0-rc.0    | ??? |???|
| A docker environment| ???   | ??? |???|
| Docker Compose    | ???   | ??? |???|

NOTE: the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of ram to your docker environment otherwise expect to have to restart the tests multiple times as the proof server hangs.


## Repository Layout
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
    │       │   └── flows/      # Example-specific typed flow functions (deposit, withdraw, …) —
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


## TODOs - NOT YET!!:
- add .github/workflows/cron-latest-sdk.yaml: a scheduled full-matrix run against *latest published* @sig-net/midnight — catches silent example rot AND breakage in newly published SDK versions.