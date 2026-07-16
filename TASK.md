# TASK: Port the erc20-vault example into this repository

Split the erc20-vault example out of the protocol repo so that:

- **Source repo** `~/Projects/github.com/sig-net/midnight-erc20-vault-refactor`
  (the "protocol repo") retains the Signature Network singleton contract and
  SDK — `packages/signet-midnight`, `packages/signet-contract`,
  `packages/signet-contract-deploy`, a pruned `packages/lib` — PLUS:
  - a **new minimal caller contract** (`packages/caller-contract`) that exercises
    the singleton generically, and a **pruned `packages/integration-tests`**
    reduced to exactly what that caller's e2e test needs (built in Phase 7,
    below, so the singleton never loses e2e coverage);
  - as a **documented exception** decided 2026-07-16 — `packages/xcontract-events`
    (Compact cross-contract research whose knowledge-base informs protocol work;
    it is NOT example code and does NOT move).
- **This repo** (`midnight-examples`) gains the vault example in the layout
  defined by [README.md](README.md), under the rules in [AGENTS.md](AGENTS.md).

## Success criteria (the definition of done)

1. All example code ported here and **deleted** from the protocol repo; what
   remains there is the singleton contract + SDK, the minimal caller contract +
   its pruned integration-test support, and the xcontract-events exception.
2. `yarn build && yarn test` passes in this repo (all unit tests).
3. The integration e2e suite passes in this repo against the local docker stack
   (`happy-day-e2e` at minimum; all five e2e specs to fully close).
4. The protocol repo passes `yarn build && yarn test` AND its new generic
   caller e2e test against its local stack after the pruning.

## Out of scope (explicitly)

- Renaming the protocol repo to `midnight-integration`.
- `cron-latest-sdk.yaml` (tracked in README TODOs).
- Sepolia anything. The e2e loop is local-only (anvil compose service). The
  `sweep-derived-funds.ts` script and Sepolia runbook stay in the protocol repo.

## Non-negotiable working rules

- **Read [AGENTS.md](AGENTS.md) first.** Every rule applies to every line ported.
  The ones that will bite: environment-agnostic contract `src/` (no `node:`
  imports, no `process.env`, no `Buffer` — `Uint8Array` only), npm-published SDK
  deps only in committed manifests, no dead code, JSDoc on exports, table-driven
  tests, no emitted JS.
- **Port, don't bulk-copy.** Each piece lands with its tests in the same phase,
  reworked to this repo's names/layout; stale code is dropped in transit, never
  carried. Every phase ends green (`yarn build && yarn test`) and is committed
  before the next begins.
- **Do not delete anything from the protocol repo until Phase 8.** The new repo
  must be fully green first — the old repo is the reference implementation while
  porting — and the caller contract's e2e test (Phase 7) must be green before
  the vault e2e suite it replaces is removed.
- **Never `workspace:`-link the SDK.** Committed example/harness manifests
  reference npm semver ranges. `yarn link` against the local protocol checkout
  is the sanctioned workaround whenever npm is behind (see P1/P2) — it must be
  recorded in the follow-ups report, never silent. Mechanics: Yarn 4's
  `yarn link <path>` writes a `portal:` entry into the ROOT `package.json`
  `resolutions` — that hunk stays OUT of every commit (commit everything else
  around it; re-create the link after pulls, per the HANDOFF.md Active-links
  entry).
- **Never block on the user.** No preflight or phase stops to wait for a human.
  Where an action is the user's (publishing a package), take the documented
  workaround, keep going, and record it in the **follow-ups report** — a
  `FOLLOW-UPS` section the agent appends to the final summary (and to the PR
  description) listing each pending user action and the re-verification it
  unlocks.

## Git strategy

- **This repo:** all work on branch `port/erc20-vault` off `main`; PR to `main`
  at the end. If the repo has no GitHub remote yet (check `git remote -v`), the
  Phase 5 "CI green" gate cannot run — validate workflow syntax locally
  (`actionlint` or careful review), and add *"push remote + confirm CI green"*
  to the follow-ups report instead of blocking.
- **Protocol repo:** all Phase 7/8 work on branch `refactor/split-examples`.
  The porting BASELINE is whatever ref the protocol repo has checked out when
  Session 1 starts — record that exact ref + commit hash in HANDOFF.md before
  anything else. If the protocol working tree is dirty, do not stash or touch
  it: note the dirty files in HANDOFF.md, port from the tree as-is, and flag it
  in the follow-ups report.
- Commits in both repos follow the phase structure — one or more commits per
  phase, each at a green state, message prefixed `port:` (this repo) /
  `refactor:` (protocol repo).

---

## Preflight gates (verify BEFORE Phase 0; never block on the user)

**P1 — SDK publish state.** Published `@sig-net/midnight` and
`@sig-net/midnight-contract` are `0.0.3` (latest = rc). The protocol repo's
working tree contains newer unpublished work (recent branches touched calldata
decoding, withdraw finalization, dust registration). Diff the published tarballs
against the local packages (`yarn pack` locally, compare). If the vault example
needs unpublished behavior, do NOT stop: `yarn link` the local protocol
checkout's packages, keep the committed manifests naming the intended npm range
(e.g. `^0.0.4`), and run all testing through the links. Add to the follow-ups
report: *"publish `@sig-net/midnight` / `@sig-net/midnight-contract` @<version>,
remove the links, re-run Phase 6 verification against npm before merge."*
CI stays red on the npm resolution until that publish lands — expected, not a
defect; local verification through the links is the Phase 6 gate in the interim.

**P2 — `@sig-net/midnight-contract-deploy` is NOT published (npm 404).** The
old integration harness deploys the singleton via this workspace package
(`integration-tests/src/setup/steps.ts` imports it), and `packages/test-harness`
here needs the same ability. Depend on it by its intended npm range in the
committed manifest, `yarn link` it from the local protocol checkout, and
proceed. Follow-ups report: *"publish `@sig-net/midnight-contract-deploy`,
remove the link, re-run Phase 6 against npm."* Do NOT copy the package's
deploy logic into test-harness to dodge the link — that trades a one-time
publish for permanent drift.

**P3 — Toolchain + images.** `corepack enable`; Yarn 4; `compact update`
(unpinned); docker images pullable: `midnightntwrk/proof-server:9.0.0-rc.3`,
`midnightntwrk/indexer-standalone:4.4.0-…`, `midnightntwrk/midnight-node:2.0.0-rc.3`,
`ghcr.io/foundry-rs/foundry:v1.5.1`, `ghcr.io/sig-net/fakenet:latest`.
zk key generation needs ~10 min and real RAM — see "Risks".

**P4 — Version pins carried from the source.** The source pins
`@midnight-ntwrk/*` prereleases exactly (`midnight-js@5.0.0-beta.3`,
`compact-runtime@0.18.0-rc.0`, `midnight-js-indexer-public-data-provider@5.0.0-beta.3`).
These are prereleases the user already opted into — carry the **same** versions
(do not "upgrade" to satisfy the no-pin rule; prereleases require explicit user
opt-in, and version *divergence* across members causes WASM dual-instance
"expected instance of…" bugs). Every member that uses them must resolve
identically. All other deps: latest stable with `^`, per AGENTS.md.

---

## Source → destination map

Legend: `src:` = protocol repo path, `dst:` = this repo. "dissolve" = the file's
responsibilities are redistributed; the file itself does not survive.

### Repo scaffolding (Phase 0)

| src | dst | notes |
|---|---|---|
| `package.json` (root) | `package.json` | new: name, `workspaces: ["packages/*", "examples/*/*"]`, root scripts (see Phase 5) |
| `.yarnrc.yml` | `.yarnrc.yml` | `nodeLinker: node-modules` |
| `tsconfig.base.json` | `tsconfig.base.json` | no-emit base, unchanged semantics |
| `docker-compose.yaml` | `docker-compose.yaml` | copy; strip anything vault-named (container names/env stay generic) |
| `.env.example`, `standalone.env.example` | `.env.example` | merge; drop dead vars (audit each against actual readers) |
| `.gitignore` | extend existing | add `dist/`, `logs/`, `midnight-level-db/`, `src/managed/` patterns etc. |

### `packages/lib` (Phase 1) — runtime helpers

| src (`packages/lib/src/`) | dst (`packages/lib/src/`) |
|---|---|
| `deploy.ts`, `midnight-node-config.ts`, `midnight-providers.ts`, `network-id.ts`, `seed.ts`, `wallet.ts` + `tests/` | same names; port with tests |

Classify as you port: anything consumed ONLY by tests/setup belongs in
`test-harness` (Phase 3), not lib. Lib is runtime-facing (deploy scripts, flows).

### `examples/erc20-vault/contract` (Phase 2) — from `packages/vault-contract`

| src | dst | notes |
|---|---|---|
| `src/erc20-vault.compact` | `src/erc20-vault.compact` | unchanged |
| `src/witnesses.ts` | `src/witnesses.ts` | must pass the env-agnostic audit |
| `src/index.ts` | `src/index.ts` | curated surface; env-agnostic |
| `src/providers.ts` | **out of `src/`** → fold into `deploy.ts` or drop | provider wiring is Node-side; nothing env-specific may stay under `src/` |
| `src/deploy-vault.ts` | fold into `deploy.ts` | same reason |
| `deploy.ts` | `deploy.ts` | Node entrypoint; lib imports allowed here only |
| `tests/contract.test.ts` | `tests/erc20-vault.test.ts` | simulator-only |
| `tests/deploy.test.ts` | `tests/deploy.test.ts` | needs `compile:zk` |
| `package.json` | new | name `@midnight-examples/erc20-vault-contract`; deps: `@sig-net/midnight@^0.0.x` (npm!), compact runtime — NOTHING else |

**Env-agnostic audit (mandatory, Phase 2 gate):** grep `src/` for `node:`,
`process.`, `Buffer`, `require(`, `fs`, `path`, `dotenv`; every hit either moves
out of `src/` or is rewritten (`Buffer` → `Uint8Array`). Config becomes function
parameters.

### `packages/test-harness` (Phase 3) — from `packages/integration-tests/src`

| src (`integration-tests/`) | dst | notes |
|---|---|---|
| `src/e2e-env.ts`, `src/env-file.ts`, `src/output.ts`, `src/preflight.ts`, `src/waitForGo.ts`, `src/flow-hooks.ts` | `test-harness/src/` | generic; make env keys parameterizable, not vault-hardcoded |
| `src/setup/global-setup.ts`, `src/setup/local-evm.ts`, `src/setup/mpc-keys.ts` | `test-harness/src/` | stack bring-up, EVM, MPC keys |
| `src/setup/steps.ts` | **split** | generic step-running → harness; vault deploy wiring → example (Phase 4); singleton deploy → harness via P2 resolution |
| `src/session.ts` | **split** | generic session mechanics → harness; vault addresses/state → example |
| `src/evm.ts` | `test-harness/src/` | if truly generic; anything TestUSDC/vault-specific → example |
| `src/signet-notifications.ts` | `test-harness/src/` | generic signet polling |
| `src/subprocess.ts` | **delete** | existed to drive the CLI; flows run in-process now. If proving OOMs in-process later, reintroduce process isolation IN THE HARNESS (worker/fork around flow fns) — never a CLI |
| `tests/env-file.test.ts`, `tests/mpc-keys.test.ts` | `test-harness/tests/` | harness unit tests move with the harness |
| `hardhat.config.ts`, `@openzeppelin/contracts`, `hardhat` deps | judgment call | generic hardhat helpers → harness; the TestUSDC contract itself → example (it is the vault's EVM counterpart) |

### `examples/erc20-vault/integration-tests` (Phase 4)

| src | dst | notes |
|---|---|---|
| `integration-tests/src/flows/deposit.ts`, `flows/withdraw.ts` | `src/flows/` | THE example artifact — typed, in-process, JSDoc'd |
| `integration-tests/src/fakenet-vault-account.ts` | `src/` | vault-specific derived account |
| vault halves of `session.ts` / `setup/steps.ts` | `src/` | from Phase 3 split |
| `integration-tests/contracts/TestUSDC.sol` | `contracts/TestUSDC.sol` | with its hardhat compile script |
| `integration-tests/tests/happy-day-e2e.test.ts`, `benchmark.test.ts`, `false-claimer.test.ts`, `deposit-withdrawal-failure-refund.test.ts`, `deposit-claimant-not-caller.test.ts` | `tests/` | rewire from subprocess-CLI calls to in-process flow calls |
| `vitest.config.ts` | `vitest.config.ts` | adjust globalSetup path to test-harness |

### CLI dissolution — `packages/cli` (Phase 4; the package does NOT survive)

| CLI piece | fate |
|---|---|
| `commands/deposit-e2e.ts`, `commands/withdraw-e2e.ts` | superseded by `src/flows/` (they were the flow compositions) |
| `commands/initialize.ts`, `deposit.ts`, `claim.ts`, `withdraw.ts`, `complete-withdraw.ts`, `broadcast-evm.ts`, `poll-signature-response.ts`, `poll-respond-bidirectional.ts`, `read-state.ts` | each becomes a thin `scripts/<name>.ts` (tsx entrypoint, ~20 lines: parse args → call flow/step fn) — but ONLY where hand-driving is actually useful; drop any nobody would run by hand rather than porting ritually |
| `src/config.ts`, `src/context.ts` | dissolve → harness env/session + lib providers |
| `src/identity.ts` | dissolve → lib (`seed.ts` neighborhood) |
| `src/evm.ts`, `src/mpc-routing.ts` | dissolve → flows/harness as consumers dictate |
| `src/vault-ledger.ts`, `src/vault-token.ts` | → example `src/` (vault state readers; candidates for the contract package's surface if env-agnostic) |
| `commander` dep, `src/main.ts`, `src/index.ts`, `tests/config.test.ts` | **deleted** (config test moves only if its subject survives in harness) |

### Docs & skills

| src | dst | notes |
|---|---|---|
| `.claude/skills/e2e/SKILL.md` | `.claude/skills/e2e/SKILL.md` | **refactored, not copied** — full spec below. The protocol repo keeps its own slimmed version, rewritten in Phase 8 for the caller e2e test |
| `docs/architecture.md`, `docs/demo-architecture.drawio.svg` | `examples/erc20-vault/` (fold into its README or `docs/`) | it describes the vault flow, not the protocol |
| `docs/e2e-sepolia-runbook.md` | stays in protocol repo | Sepolia is parked and protocol-adjacent |

### The refactored `/e2e` skill (drafted in Phase 5, validated in Phase 6)

**Primary audience and trigger:** a user on a FRESH CLONE saying "run the
erc20 vault example tests e2e for me." The old skill assumes an initialized
working checkout; the new one must take a bare clone to a green suite
unassisted. Write the frontmatter `description` to trigger on running,
re-running, or re-deploying the example e2e stack.

**Structure (in this order):**

1. **Fresh-clone quickstart** — the zero-to-green path, exact ordered commands:
   `corepack enable` → `yarn install` → `compact update` → `yarn compile:zk`
   (BACKGROUND it, ~10 min keygen, log to file) → `docker compose up -d`
   (stack: node :9944, indexer :8088, proof server :6300, anvil :8545,
   fakenet) → `yarn test:erc20-vault:e2e > <logfile> 2>&1 &` and watch the
   log. No pre-existing `.env` required: setup creates it and appends the
   fakenet hand-off values (append-only; env-var conflict = hard error).
2. **Modes** — rerun against kept `.env` addresses (setup steps log
   `SKIPPED`) vs redeploy after a circuit change (comment out the contract
   address vars, rerun; on the local EVM the whole redeploy completes in ONE
   run — funding is automatic, the responder hand-off is automatic).
3. **Ground rules** — background any run that may zk-compile; never enable
   the step-through/stdin-pausing mode unattended (carry over only if that
   mode survives the port); the suite bails on first failure; expected
   per-spec test counts (update to the ported suite's real numbers).
4. **Fakenet responder** — managed-by-setup as default (`--force-recreate`
   semantics: re-reads `.env` AND resets responder LevelDB state);
   `FAKENET_MANAGED=0` for responder development (`yarn response` in a
   solana-signet-program checkout); healthy-startup log line to check.
5. **Reading failures** — port these, updating paths/var names, they are
   hard-won: proof-server OOM playbook (claim leg tips over a 16 GB Docker
   VM; restart `midnight-proof-server`, rerun the SAME spec with its resume
   var — `DEPOSIT_REQUEST_ID` etc.; `broadcastEvm` is idempotent); responder
   killed mid-post by a proof-server restart (plain `restart`, backfill
   re-posts; "quiet log" means no in-flight post, not no output); signature
   polls timing out ⇒ responder down or watching stale addresses;
   `Inputs did not match alignment` ⇒ the ≥2-variant-enum rule.

**Drop entirely (do NOT port):** all Sepolia content — funding preflights and
ETH/USDC minimums, the sweep procedure and `sweep-derived-funds.ts`, the
funding-wallet seed comment, "expected stopping point" failures. On the local
stack a fresh deploy runs green in one pass; the skill must say so plainly.
Also drop: every old root-script name (use the Phase 5 names), every
`packages/integration-tests` path (use `examples/erc20-vault/…`), and any
reference to the dissolved CLI.

**Simplification to exploit:** prover/verifier parity is BY CONSTRUCTION here
— the singleton is always deployed from the published
`@sig-net/midnight-contract` (same package the fakenet image proves with), so
the old skill's parity troubleshooting shrinks to one line: parity only breaks
when a P1/P2 yarn link is active, in which case use the compose bind-mount
overlay for the responder's keys.

**Validation (Phase 6):** the fresh-clone verification MUST be executed by
following SKILL.md verbatim, not from memory. Every divergence found is a
skill bug — fix the skill in the same session. The skill is done when an agent
that has never seen this repo can go clone → green suite with no other input.

---

## Phases

Each phase: implement → `yarn build && yarn test` (all green) → commit.

**Phase 0 — Scaffold.** Root manifests, yarnrc, tsconfig.base, .gitignore,
docker-compose, .env.example. Empty workspaces resolve (`yarn install` clean).

**Phase 1 — lib.** Port + tests. Gate: lib tests green.

**Phase 2 — contract.** Port vault-contract into the new shape. Gate:
`yarn compile` (skip-zk) + simulator tests green; env-agnostic audit clean;
`compile:zk` + `deploy.test.ts` green (slow — run once, background it).

**Phase 3 — test-harness.** Port + split per map. Depends on P2 resolution for
singleton deploy. Gate: harness unit tests green; a smoke script can bring the
compose stack up and tear it down.

**Phase 4 — example integration-tests + scripts.** Flows, vault-specific
helpers, TestUSDC, the five e2e specs rewired in-process, `scripts/` drivers.
Also write `examples/erc20-vault/README.md` (what the example demonstrates,
how to run it, folding in `docs/architecture.md` per the Docs table).
Gate: typecheck green; `happy-day-e2e` passes against the local stack.

**Phase 5 — root scripts + CI + `/e2e` skill.** Root scripts per AGENTS.md
naming (`compile:erc20-vault`, `compile:erc20-vault:zk`, `deploy:erc20-vault`,
`test:erc20-vault`, `test:erc20-vault:e2e`, aggregates `compile`/`build`/`test`
unsuffixed; grep the repo for every name you introduce or change).
`.github/workflows/example-test.yaml` (reusable) + `erc20-vault.yaml` (thin
caller, paths-filtered). Draft `.claude/skills/e2e/SKILL.md` per the spec in
"Docs & skills". Gate: CI green on a PR branch.

**Phase 6 — Full verification.** Fresh clone, then follow
`.claude/skills/e2e/SKILL.md` VERBATIM (this validates the skill and the repo
in one pass): install → `compact update` → `compile:zk` → compose up → ALL
five e2e specs + full unit suite. Fix every skill divergence in-session. This
is criterion 2 + 3. Record timings in the example README's test section.

**Phase 7 — Minimal caller contract + generic e2e (protocol repo).** Only after
Phase 6 is green. Built BEFORE deletion so the singleton never loses e2e
coverage, and so the vault suite is still present as the working reference.
- New `packages/caller-contract`, shaped exactly like the other contract
  packages (curated `src/index.ts`, witnesses beside the contract, simulator
  tests, own `deploy.ts`). The Compact contract is the SMALLEST thing that
  exercises the singleton generically: submit a signature request with fixed
  minimal calldata, and verify the Schnorr response. No token, no vault
  semantics, no business logic — if a line isn't needed to drive the singleton,
  it doesn't belong here.
- One generic e2e test in `packages/integration-tests`: deploy singleton
  (via `signet-contract-deploy` — workspace dep is fine inside this repo),
  deploy caller, request → fakenet responds → poll → verify response. Include
  the EVM broadcast leg only if the response pipeline requires it; if anvil is
  not needed, drop it from this test's stack requirements.
- Reuse the existing harness files as-is where possible; this phase ADDS, it
  does not yet prune.
- Root scripts: `compile:caller-contract`, `compile:caller-contract:zk`,
  `deploy:caller-contract`, `test:integration-tests` retargeted.
- Gate: caller simulator tests + the generic e2e green against the local stack.

**Phase 8 — Deletion & pruning (protocol repo).** Only after Phase 7 is green:
- Delete `packages/vault-contract` and `packages/cli`.
- Prune `packages/integration-tests` to exactly what the generic caller e2e
  needs: keep the harness spine (env/session, global-setup, mpc-keys,
  signet-notifications, waitForGo, preflight; local-evm only if Phase 7 kept the
  EVM leg); delete flows/, fakenet-vault-account, TestUSDC + hardhat + the
  `@openzeppelin`/`hardhat` deps (unless the EVM leg needs them), the five vault
  e2e specs, subprocess.ts, and the `@midnight-erc20-vault/cli` +
  `vault-contract` deps.
- Prune `packages/lib` to what remaining members import (consumers:
  signet-contract-deploy, caller-contract, integration-tests). Delete orphans —
  no dead code.
- Root `package.json`: remove `compile:vault-contract*`, `deploy:vault-contract`,
  `cli`, `compile:integration-tests:evm` (if the EVM leg is gone), and the five
  per-spec `test:integration-tests:*` scripts; keep `test:integration-tests` +
  the caller-contract scripts from Phase 7.
- `.github/workflows/ci.yml`: replace vault/integration jobs with the caller e2e.
- `AGENTS.md`: remove vault references; rewrite the e2e section around the
  caller test; keep timeless.
- `.claude/skills/e2e`: rewrite (slim) for the caller e2e stack; move
  `scripts/sweep-derived-funds.ts` out to `scripts/` first. Update
  `.claude/skills/contract-change` (its retest pipeline references the vault
  suite).
- `README.md`: remove the temporary porting banner; describe the repo as
  singleton + SDK + generic caller test; note examples live in
  `sig-net/midnight-examples`.
- KEEP: `docker-compose.yaml`, `docs/e2e-sepolia-runbook.md`,
  `packages/xcontract-events`.
- Gate: protocol repo `yarn install && yarn build && yarn test` green AND the
  generic caller e2e green (criterion 4). Commit on a branch; the user merges.

---

## Session plan (context-window boundaries)

This task does not fit one agent session. Run it as EIGHT sessions; never start
a phase you cannot finish and verify within the session. The heavy context
consumers are (a) reading source files during a port, (b) e2e debug loops —
the boundaries below isolate those.

| Session | Scope | Why it's one session |
|---|---|---|
| 1 | Preflight P1–P4 + Phase 0 + Phase 1 | scaffold is cheap; lib is 6 files + tests |
| 2 | Phase 2 (contract) | env-agnostic audit needs the whole package in context; `compile:zk` runs in background while tests are written |
| 3 | Phase 3 (test-harness) | heaviest reading load: classifying + splitting `session.ts`/`steps.ts` needs many source files open at once |
| 4 | Phase 4a: flows + vault helpers + scripts + `happy-day-e2e` green | first e2e pass has the biggest debug risk; give it a full session's headroom |
| 5 | Phase 4b: remaining four e2e specs + Phase 5 (root scripts, CI, `/e2e` skill draft) | specs rewire mechanically once happy-day works; CI is small; the skill is written while the operational knowledge is fresh |
| 6 | Phase 6 (fresh-clone full verification, following the `/e2e` skill verbatim) | pure verification + debugging; start clean so there's room for failure analysis |
| 7 | Phase 7 (caller contract + generic e2e, protocol repo) | new Compact contract + new test; different repo, different context |
| 8 | Phase 8 (deletion & pruning, protocol repo) | mechanical but wide; doc rewrites need free context |

If a session runs long (e.g. an e2e debug loop), STOP at the last green commit
and hand off — a mid-phase handoff at a green commit beats a completed phase
with a poisoned context. Update the session table's scope split in this file
when that happens.

## Handoff protocol

**`HANDOFF.md`** at this repo's root is the session-to-session state file.
Session 1 creates it; it is committed on the working branch (both repos' work
is tracked in THIS one file), deleted in the final cleanup. TASK.md stays the
*plan* — when reality diverges from a mapping table, amend the table in the
same commit and note the deviation in HANDOFF.md; the next session must never
have to re-derive a decision.

The file opens with a running **`## FOLLOW-UPS`** section (pending user
actions: publishes, remote setup, dirty-tree notes). Sessions append to it as
items arise; the final session delivers it verbatim in the summary and PR
description.

**At the END of every session, append a section:**

```markdown
## Session N — <date> — <phases/scope worked>
- Status: <phase> COMPLETE | IN PROGRESS (stopped at <last green commit>)
- Commits: <hash> <one-liner> (per commit, both repos, prefix repo name)
- Deviations from TASK.md: <what + why, or "none"> (tables already amended)
- Active yarn links: <package → local path, or "none">
- Environment state: docker stack up/down; zk keys compiled for <packages>;
  anything running in background
- Discovered gotchas: <anything the Risks section doesn't already cover —
  also append it to Risks if it will recur>
- Next session first action: <one concrete step, e.g. "run X, expect Y">
```

**At the START of every session (onboarding — do these IN ORDER):**

1. Read [AGENTS.md](AGENTS.md) (rules), then this file top-to-bottom, then
   `HANDOFF.md` (all sessions, latest last).
2. Trust the handoff — do NOT re-read already-ported source files wholesale or
   re-litigate decisions recorded here or there; context spent re-deriving is
   context stolen from the port.
3. Re-establish the baseline before writing anything:
   `git -C <both repos> status` (expect clean at the recorded commit),
   `yarn install`, `yarn build && yarn test` green, restore any recorded yarn
   links (they are NOT committed — re-create per the Active-links entry),
   `docker compose ps` matches the recorded environment state.
4. If the baseline is NOT green, fixing it IS the session's first task — record
   what broke in HANDOFF.md before proceeding.
5. Execute this session's scope from the table; finish with the end-of-session
   append.

## Orchestrated execution (running sessions as subagents)

The sessions do not require eight separate human-driven conversations. The
intended execution model is one **orchestrator** agent conversation that spawns
each session as a **subagent with its own fresh context window**, strictly
sequentially. A fresh subagent is exactly the "next session that knows nothing"
the handoff protocol was designed for — the onboarding steps above are the
subagent's prompt preamble, verbatim.

Rules for the orchestrator:

- **Spawn sessions strictly in order; never two at once.** Each depends on the
  previous session's commits and HANDOFF.md entry.
- **Keep the work out of your own context.** Consume only each subagent's final
  report plus cheap spot-checks (`git log`, the new HANDOFF.md entry). Never
  read ported source wholesale — that defeats the architecture.
- **Subagent reports mirror the HANDOFF.md entry format** (status, last green
  commit, deviations, active links, environment state, next action) so
  report-vs-repo consistency is verifiable in a few lines. A report that
  disagrees with HANDOFF.md or `git log` is itself a defect — reconcile before
  spawning the next session.
- **Judgment checkpoints stay with the orchestrator (or the user):** P1 tarball
  diff conclusions, the `session.ts`/`steps.ts` split boundaries, whether the
  caller e2e needs the EVM leg, anything destined for the follow-ups report.
  Subagents flag these in their report; they do not unilaterally decide and
  bury the decision.
- **Steer, don't respawn:** if a session's report needs clarification or a
  small correction, continue THAT agent (its context is intact) rather than
  starting a fresh one mid-phase. Respawning is for the next session boundary.
- **A stalled or off-rails session** ends the same way a long one does: stop it
  at the last green commit, have it write its HANDOFF.md entry (or write it
  yourself from `git log` if the agent is unrecoverable), and spawn the next
  session against that entry.
- **Pacing:** sessions are wall-clock heavy (zk keygen ~10 min, e2e runtime).
  Running 2–3 sessions per sitting and resuming the orchestrator later is
  normal; the orchestrator itself re-onboards from HANDOFF.md exactly like a
  session does, so nothing is lost between sittings.
- **Permissions:** subagents inherit the orchestrating session's permission
  mode. The phases run docker, commit in two repos, install packages, and may
  `yarn link` — either a human is present to approve, or the session runs with
  permissions that won't stall a subagent mid-phase.

## Risks & gotchas (learned the hard way; do not rediscover)

- **WASM dual-instance:** every member must resolve each `@midnight-ntwrk/*`
  package to ONE version, or you get "expected instance of…" at runtime.
- **Claim-proof OOM:** proving the claim in-process has OOM'd before. If it
  recurs: raise `NODE_OPTIONS=--max-old-space-size`, run specs serially
  (vitest `fileParallelism: false`), and only then consider harness-level
  process isolation.
- **zk keygen pacing:** `compile:zk` runs ~10 minutes. Background it; never
  let it look like a hang. CI must cache `src/managed/` keyed on the compact
  source + compiler version.
- **Fakenet NIGHT/dust quirk:** register only unregistered NIGHT utxos for dust
  generation when reusing a wallet (protocol repo commit `ee01765` is the
  reference); fresh wallets per run avoid it entirely.
- **TS twins:** never re-implement a pure circuit in TS during the port — call
  the SDK's `pureCircuits.<name>`. If a CLI helper secretly duplicated circuit
  logic, that is a bug to fix in transit, not port.
- **Address byte order:** signet address calldata args are big-endian (protocol
  repo commit `0066935`). The flows already encode this — port the tests that
  pin it.

## Final checklist

- [ ] P1–P4 preflight resolved (P1/P2 via yarn link if npm is behind — recorded
      in the follow-ups report, never blocking)
- [ ] Phases 0–5 each committed green
- [ ] Phase 6: full unit + all five e2e specs green from a fresh clone
- [ ] Phase 7: caller contract + generic singleton e2e green in the protocol repo
- [ ] Phase 8: protocol repo pruned, unit + caller e2e green, on a branch for
      user review
- [ ] No `workspace:`/`link:`/`portal:` SDK refs in any committed manifest
      (committed manifests name npm ranges even while local links are active)
- [ ] Follow-ups report delivered: every pending user publish listed with the
      re-verification step it unlocks (empty report if npm was sufficient)
- [ ] `HANDOFF.md` reviewed for unresolved deviations, then deleted in the
      final cleanup commit
- [ ] Contract `src/` passes the env-agnostic grep audit
- [ ] `/e2e` skill validated: the Phase 6 fresh-clone run followed SKILL.md
      verbatim and every divergence was fixed in the skill
- [ ] Both repos' READMEs/AGENTS.md reflect reality (no stale references)
