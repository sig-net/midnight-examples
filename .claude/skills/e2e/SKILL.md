---
name: e2e
description: Run the erc20-vault example's e2e suite (examples/erc20-vault/integration-tests)
  against the local docker stack — from a fresh clone to a green suite, reruns
  against kept contract addresses, or clean redeploys after a circuit change,
  including the fakenet MPC responder hand-off. Use whenever running,
  re-running, or re-deploying the example e2e stack.
---

# e2e — run the erc20-vault example suite

This runbook is plain markdown on purpose: any agent or human can follow it,
not just Claude Code. It assumes NOTHING beyond a clone of this repository —
follow the quickstart top to bottom and a bare checkout ends at a green
five-spec suite. The pipeline itself (globalSetup steps + flow test files)
lives in `examples/erc20-vault/integration-tests/`; setup (compile, deploy,
key and address derivation, responder hand-off) runs in vitest globalSetup
before ANY flow file — including single-file runs — and flow files run one at
a time in the order pinned by that package's `vitest.config.ts`.

## Fresh-clone quickstart (zero to green)

Run everything from the repo root, in this order:

```sh
corepack enable                # yarn 4 via the packageManager field
yarn install                   # NEVER from inside a member package
compact update 0.33.0-rc.2     # the ledger-9 rc toolchain — see the toolchain note
docker compose up -d           # node :9944, indexer :8088, proof server :6300, anvil :8545
yarn test:erc20-vault:e2e > e2e-run.log 2>&1 &        # BACKGROUND it, watch the log
```

The first run's setup pipeline performs the ~10-minute zk keygen itself (its
skip conditions — a deployed contract address in `.env`, or CI's
`TRUST_PREBUILT_ZK_KEYS` cache contract — never hold on a fresh clone), so do
NOT run `yarn compile:erc20-vault:zk` separately first: the setup recompiles
regardless and you pay keygen twice. Expect the whole first invocation to take
~20–25 minutes (keygen + fresh deploys + the flow tests).

**Toolchain note:** the contracts declare `pragma language_version >= 0.25`,
which needs the ledger-9 rc compiler (0.33.0-rc.2 — part of the matched set
pinned in `docker-compose.yaml`'s image-tag comment). A bare `compact update`
installs latest STABLE (0.31.1, language 0.23) — and DOWNGRADES the default if
an rc is already active — after which the compile fails with
`language version 0.23.0 mismatch`. If `compact` itself is missing, or the
launcher's channel refuses the rc version, use the installer + direct-download
recipe in `.github/workflows/example-test.yaml` (the `Install / update the
compact toolchain` step).

No pre-existing `.env` is required: the setup pipeline creates it and appends
the generated wallet seeds (root + the deployer/user/mpc responder/bearer
roles, funded from root) and the fakenet hand-off values (`MPC_ROOT_KEY`,
`MIDNIGHT_SIGNET_CONTRACT_ADDRESS`) plus prints a ready-to-paste block with
everything else it deployed/derived. Appends are append-only — existing lines
are never modified, and a value that conflicts with the shell environment is
a hard error, not an overwrite. On the local EVM (the compose anvil,
chain id 31337) a fresh DEPLOY runs green in ONE pass: funding of the derived
accounts is automatic, TestUSDC is auto-deployed, and the setup starts the
fakenet responder itself mid-run. The FLOW files are another matter: on a
16 GB Docker VM expect the proof-server OOM (see "Reading failures") to
interrupt the suite at some proving leg partway through the five files —
that is routine, not a defect; recover per the playbook and the suite
completes across two or three invocations.

After the run, paste the setup's printed `.env` block into `.env` (the
contract addresses in particular) so the next run is a fast rerun against
kept contracts.

## Modes

- **`/e2e`** (default) — rerun against the addresses already in `.env`.
  Setup steps log `SKIPPED: …`; no compiles or deploys.
- **`/e2e redeploy`** — a circuit changed (any `.compact` edit that alters a
  circuit, struct layout, or the request-id hash domain): comment out
  `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`,
  `EVM_VAULT_ADDRESS`, `EVM_USER_ADDRESS` (and `ERC20_ADDRESS` if the anvil
  container restarted — its chain is in-memory) in `.env`, then rerun. The
  whole redeploy completes in ONE run: setup re-compiles (zk keygen, ~10 min
  — background the run), redeploys, re-derives, re-funds, and
  `--force-recreate`s the responder automatically. Afterwards, update `.env`
  with the freshly printed values and delete the commented-out old lines.
  (The derived EVM accounts move on a redeploy — `EVM_VAULT_ADDRESS` and
  `EVM_USER_ADDRESS` are epsilon-derived from the vault contract address —
  but on the local chain the new accounts are simply funded by setup;
  nothing needs sweeping.)

## Ground rules (violating these wastes 10+ minutes per mistake)

- Run the suite from the repo root: `yarn test:erc20-vault:e2e` (all five
  specs) or `yarn test:erc20-vault:e2e tests/<spec-file>` for one spec (the
  setup pipeline still runs first; extra args pass through to vitest).
- **Background any run that may zk-compile or deploy** (fresh clone,
  redeploy): `> logfile 2>&1 &`, then watch the log. Never sit on a
  foreground call with a short timeout — keygen alone is ~10 minutes.
- **Never set `STEP_THROUGH=1` in an unattended run** — it pauses for stdin
  between tests and hangs forever.
- The suite is `vitest --bail 1` and the spec files run serially in a pinned
  order: it stops at the first failure.
- Expected per-spec test counts, in run order: `happy-day-e2e` **15**,
  `deposit-withdrawal-failure-refund` **9**, `deposit-claimant-not-caller`
  **6**, `benchmark` **13**, `false-claimer` **6**, `bearer-transfer` **11**
  — 60 total.
- **Wallets are role wallets funded from ROOT at setup.** The setup's
  wallet steps resolve/generate `ROOT_SEED` plus the role seeds
  (`DEPLOYER_SEED`, `USER_SEED`, `MPC_RESPONDER_SEED`, `BEARER_SEED`),
  persist generated ones to `.env` (append-only), and fund each role from
  root with dust-registered NIGHT (on the local chain root is the genesis
  mint wallet, so this is fully automatic; on a deployed network the first
  run stops printing root's NIGHT address to faucet-fund). The older
  "dust-poison" rule (a runtime NIGHT transfer/registration bricking every
  wallet's dust spend proofs, error 170) does NOT apply on the node
  2.0.0-rc.4 line — runtime funding is how the roles are provisioned now.
  Receive-only test wallets (`…42`, `…43`) need no funding at all.
- Every test from the first signature poll onward needs the **fakenet MPC
  responder running** with the CURRENT contract addresses — see the next
  section. A signature/attestation poll timing out while earlier contract
  calls passed almost always means the responder is down or watching stale
  addresses.
- Give the Docker VM **16 GB**: a single claim/settle proof peaks above
  12 GiB inside the proof server (see the OOM playbook below).
- On a 16 GB VM, **restarting the proof server between spec files is the
  DEFAULT cadence, not just OOM recovery** — the OOM consistently hits a
  proving leg once the same server instance has already served several
  proofs (observed on claim legs and once on a benchmark deposit leg).
  For an attended run: `yarn test:erc20-vault:e2e tests/<spec-file>` per
  file in the pinned order, `docker restart midnight-proof-server` between
  files (only while the responder log is quiet — see the responder-killed
  bullet under "Reading failures"). An unattended full-suite invocation is
  fine too — just expect to apply the OOM playbook when it interrupts.

## The fakenet responder

The `fakenet` compose service (`ghcr.io/sig-net/fakenet`, version pinned in
`docker-compose.yaml`, built from
sig-net/solana-signet-program, Midnight-only via `DISABLE_SOLANA`) is the MPC
stand-in: it polls the signet contract's notification registry via the
indexer, signs EVM transactions with keys derived from `MPC_ROOT_KEY`, and
posts responses through the proof server.

- **Managed by setup (default):** the setup's hand-off steps append
  `MPC_ROOT_KEY` + `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to `.env` and run
  `docker compose --profile fakenet up -d fakenet` — with `--force-recreate`
  exactly when values newly landed in `.env` (recreate re-reads `.env` AND
  resets the responder's container-local LevelDB state). A running responder
  with current values is left untouched.
- **The service is profiled**: a plain `docker compose up -d` does not start
  it, and a plain `docker compose down` does NOT remove it — use
  `docker compose --profile fakenet down` to tear the whole stack down.
- **Healthy startup check:** `docker logs fakenet-responder` prints
  `MidnightMonitor: polling signet contract registry at <signet address>` —
  verify the address matches your `.env`.
- **Responder development:** set `FAKENET_MANAGED=0` so setup leaves the
  responder — and `.env` — alone, and run it yourself (`yarn response` in a
  solana-signet-program checkout, with the current signet address and root
  key in its config). Then a poll timeout is YOUR restart to do.
- **Prover/verifier parity is by construction here:** the singleton is
  always deployed from the published `@sig-net/midnight-contract` — the same
  package the fakenet image proves with. Parity only breaks when a yarn link
  against a local protocol checkout is active AND that checkout's signet
  contract diverges from the published package; in that case bind-mount the
  checkout's `signet-contract/src/managed` over the responder's keys in the
  `fakenet` compose service.

## Reading failures

- **`connect ECONNREFUSED 127.0.0.1:6300` mid-claim/settle**, with
  `docker ps -a` showing `midnight-proof-server` `Exited (137)` (and
  `docker inspect midnight-proof-server --format '{{.State.OOMKilled}}'`
  printing `true`): the proof server was OOM-killed — the claim/settle
  proofs peak above 12 GiB, so a 16 GB Docker VM is marginal. Recover with
  `docker restart midnight-proof-server`, then rerun the SAME spec file
  resuming its pending request instead of spending another deposit:
  `<RESUME_VAR>=<id> yarn test:erc20-vault:e2e tests/<spec-file>`.
  Resume vars (each spec prints its ids in banners as it goes):
  - `happy-day-e2e` — `DEPOSIT_REQUEST_ID` / `WITHDRAW_REQUEST_ID`
  - `deposit-withdrawal-failure-refund` —
    `FAILURE_REFUND_DEPOSIT_REQUEST_ID` / `FAILURE_REFUND_WITHDRAW_REQUEST_ID`
  - `deposit-claimant-not-caller` —
    `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID`
  - `benchmark` — `BENCHMARK_DEPOSIT_REQUEST_ID` / `BENCHMARK_WITHDRAW_REQUEST_ID`
  - `false-claimer` — `FALSE_CLAIMER_DEPOSIT_REQUEST_ID`
  - `bearer-transfer` — `BEARER_TRANSFER_DEPOSIT_REQUEST_ID` /
    `BEARER_TRANSFER_WITHDRAW_REQUEST_ID`

  `broadcastEvm` is idempotent, so already-mined transfers skip through, and
  every spec skips already-claimed/settled requests cleanly. Expect the OOM
  (when it comes) at a proving leg once the same server instance has served
  several proofs — most often the CLAIM (by the time a claim proves, the
  server has already done the deposit proof plus the responder's two posts),
  but a file's first DEPOSIT prove can also be the victim when earlier spec
  files exhausted the server. If the OOM killed the prove itself — the spec
  failed at a `callTx.…` with `/prove … ECONNREFUSED` and printed NO
  request-id banner — there is nothing to resume: rerun the spec plain (it
  spends a fresh deposit). On the resumed/rerun invocation the interrupted
  proof is the FIRST on a fresh server and the rest of the file fits in the
  remaining headroom.
- **A signature poll timing out on a request the responder DID log as "New
  request"**, with `postSignatureResponse … FAILED` + a proof-server
  transport error in `docker logs fakenet-responder`: the responder proves
  its posts through the SAME proof server (:6300), and a proof-server
  restart during its post kills the post — the responder does not retry, so
  the request strands unresponded. Recover with
  `docker compose --profile fakenet restart fakenet` (a plain restart; its
  startup backfill re-discovers unresponded requests and posts the missing
  responses), then rerun the spec with its resume var. Corollary: restart
  the proof server only while the responder's log is quiet — "quiet" means
  no in-flight post (every `post… started` line has its `took Ns`/`FAILED`
  twin), NOT an unchanged log: the idle poll loop writes every few seconds.
- **`No test files found, exiting with code 1`** from vitest: usually a
  globalSetup THROW, not a test-discovery problem — the real error is the
  `Unhandled Error` block below it. Read that first.
- **`Failed Proof Server response … /check … 400`** with
  `Inputs did not match alignment` in the proof-server docker logs: a
  circuit/runtime encoding disagreement. Known cause: a 1-variant enum in a
  `persistentHash`ed struct (`bytes(0)` atom — the compiler allocates one
  field element, the ledger parses zero). Keep every enum in hashed structs
  at ≥ 2 variants (`TxParamType` carries a `reserved` padding variant for
  exactly this).
- **Preflight `expected 0 to be greater than or equal to …`**: a derived EVM
  account is unfunded. On the local stack that means the anvil container
  restarted (its chain is in-memory) while `.env` still holds the old
  addresses — comment out `ERC20_ADDRESS`, `EVM_VAULT_ADDRESS`,
  `EVM_USER_ADDRESS` and rerun; setup redeploys TestUSDC and re-funds.
- **`vault is already initialized`** on a kept address is informational; the
  test still asserts state and passes.
- **`Insufficient funds: … Dust`** from a deploy/call: the wallet's NIGHT
  has not generated spendable DUST yet — the setup's own retry loop
  (`retryDeployWhileDustGenerates`) normally absorbs this; if it surfaces in
  a flow, rerun (dust accrues on its own).
- **`1010: Invalid Transaction: Custom error: 170`** (`InvalidDustSpendProof`)
  on every submit, from every wallet: historically the "dust-poison" state a
  runtime NIGHT movement caused on the pre-rc.4 node line (confirmed NOT to
  reproduce on 2.0.0-rc.4, where the setup's root-funding transfers are
  routine). If it does surface, reset the stack
  (`docker compose --profile fakenet down && docker compose up -d`),
  comment out the contract-address vars in `.env`, and redeploy. The full
  node error table lives at
  https://docs.midnight.network/nodes/error-codes.
