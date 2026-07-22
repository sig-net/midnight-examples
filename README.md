# Midnight Contracts Calling Foreign Chains with Sig Network

This monorepo contains experimental example projects demonstrating Midnight contracts leveraging the Sig Network [Distributed MPC](https://github.com/sig-net/mpc) to execute arbitrary transactions on foreign blockchains.

They show how builders can integrate with the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to bring functionality on foreign blockchains to their contracts on Midnight. 

The **Sign Bidirectional Flow** comprises of 5 Steps:
1. Client calls a Contract on Midnight which requests a signature for a transaction destined for a foreign chain
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain
4. Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight
5. Client extracts the signed foreign execution output, then submits it back to the Midnight contract completing the foreign transacttion execution.

Jump to the [Quickstart](#quickstart) to get going or start reading at [Repository Layout](#repository-layout) to gain a deeper understanding of what you can find in this repository.

> ## ⚠️ CAUTION ⚠️
>
> This is an example application for educational and experimental purposes.
> Use at your own risk and expect rapid iteration.

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
4. Run the happy day test and watch it go. The first run can take **~20–25 minutes** (it generates zk proving keys, deploys every contract and funds the derived accounts, all automatically no `.env` inserts needed):
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

**NOTE:** The most common reason that the run fails is as a result of the proof server hanging or crashing when it exhausts memory on a proving leg. This happens routinely, even on a Docker VM with 16 GB of RAM (the heavy claim/settle proofs peak above 12 GiB). This most often presents as the test failing with `connect ECONNREFUSED 127.0.0.1:6300` partway through a claim or settle step, with `docker ps -a` showing the `midnight-proof-server` container as `Exited (137)`, i.e. OOM-killed. If this happens it is usually possible to restart the proof server and pick up the test run at the last successful chain interaction instead of starting over using variables printed out in banners as the test progresses. See [test run recovery](./examples/erc20-vault/README.md#test-run-recovery) in the erc20-vault integration testing package for more details.

# Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node; the repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2 | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/example-test.yaml](.github/workflows/example-test.yaml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine — with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop; plugin package on Linux |

**NOTE:** the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of ram to your docker environment otherwise expect to have to restart the tests multiple times as the proof server hangs.

# Running against Sepolia

By default the EVM leg runs on the local anvil dev chain from `docker-compose.yaml`. To point it at Sepolia instead, only the EVM side changes — the Midnight stack and the fakenet MPC responder stay local. Minimal changes, all in `.env`:

```sh
# Both must point at the SAME chain — the tests' endpoint and the responder's
# container-side twin (an Infura/Alchemy/etc. Sepolia RPC URL works for both):
EVM_RPC_URL=https://sepolia.infura.io/v3/<your-key>
FAKENET_EVM_RPC_URL=https://sepolia.infura.io/v3/<your-key>

# Required on any non-local chain (setup refuses to guess): an existing ERC20
# with code on Sepolia, e.g. a test USDC deployment.
ERC20_ADDRESS=0x...
```

Then recreate the responder so it re-reads `.env` (`docker compose --profile fakenet up -d --force-recreate fakenet`) and run the test as usual. The chain id (11155111) is resolved from the RPC automatically and sealed into the vault contract at initialize.

What does NOT happen automatically on a real chain, by design:

- **No auto-funding.** The flows spend from two EVM accounts *derived from the vault contract's address* — you only learn them mid-run, when setup prints `EVM_VAULT_ADDRESS` / `EVM_USER_ADDRESS` with funding hints (the user account needs ≥ 0.01 ETH for gas and ≥ 0.1 USDC; the vault account needs ETH for withdrawal gas). Fund them when printed, either across two runs (first run derives + prints, second run tests) — or in one attended run with `STEP_THROUGH` (below).
- **No token deploy.** TestUSDC auto-deploys on the local chain only; on Sepolia you bring your own `ERC20_ADDRESS`.
- A redeploy of the vault contract derives **new** accounts — previously funded ones don't move with it.

## Watching a run step by step: `STEP_THROUGH=1`

```sh
STEP_THROUGH=1 yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts
```

pauses before every setup step and every test (after the first) until you press Enter — each pause names the step about to run. Recommended for seeing exactly how the sign-bidirectional flow unfolds, and **specifically recommended on Sepolia with Infura**: you can fund the derived accounts the moment they're printed (completing everything in one run), watch each transaction confirm on Etherscan before releasing the next leg, and avoid bursts against Infura rate limits. Attended runs only — it waits on stdin forever, so never set it in CI or an unattended/backgrounded run.


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