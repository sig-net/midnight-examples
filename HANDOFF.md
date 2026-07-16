# HANDOFF — erc20-vault port, session-to-session state

Read TASK.md first; this file records what each session actually did, the
running follow-ups list, and the decisions the next session must not re-derive.

## FOLLOW-UPS (pending user actions)

- **Publish `@sig-net/midnight-contract-deploy` to npm** — RESOLVED 2026-07-16.
  **Decision (user): Option B** — the private `@midnight-erc20-vault/lib` is NOT
  published; the deploy plumbing it provided MOVED into
  `@sig-net/midnight-contract-deploy` (protocol repo branch
  `refactor/self-contained-contract-deploy` @ 3537b84), published alone at
  0.0.3 (`latest`). De-link executed the same day: both portals + the three
  effect pins removed from BOTH checkouts (primary + fresh clone), `yarn
  install` resolves from npm, offline unit suite green, happy-day 15/15 green
  from the clone (after one transient node rejection and one routine
  proof-server OOM — both environmental, playbook applied). NO yarn links are
  active anywhere anymore. Yarn 4.17's release-age quarantine blocked the
  fresh publish; `.yarnrc.yml` now carries `npmPreapprovedPackages:
  ["@sig-net/*"]` (committed — CI needs it too). The skill's "until published"
  bridge paragraph was removed. Sessions 7/8: in the protocol repo the deploy
  plumbing now lives in signet-contract-deploy, NOT lib (lib retains only the
  midnight-js provider adapters); that branch is unmerged — coordinate with
  the user on merging it before/during Session 7.
- **Protocol repo working tree dirty** — RESOLVED before Session 3: the user
  committed the README hunk as `cae104b update repository layout` (only
  README.md changed; no ported source affected). The porting baseline is
  otherwise unchanged; protocol tree now clean at `cae104b`.
- **Protocol repo's local chain state was reset by Session 3's smoke gate**
  (both repos' compose files use the same container names, so the protocol
  stack had to come down for the examples stack to come up; recreating it
  starts a fresh chain). Its 5 containers are back up, but the contract
  addresses in the PROTOCOL repo's `.env` are now stale — before rerunning
  the protocol repo's e2e suite, comment out its `MIDNIGHT_*_CONTRACT_ADDRESS`
  (and derived EVM/ERC20) values so its setup redeploys.
- **PRIMARY examples checkout's `.env` contract addresses are stale**
  (Session 6's fresh-clone verification took the stack over — chain state
  reset; the clone's stack now owns the shared container names). Before the
  next e2e run from the PRIMARY checkout: either adopt the fresh-clone run's
  printed `.env` block (its contracts live on the currently running chain —
  values in the Session 6 entry) or comment out
  `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`,
  `ERC20_ADDRESS`, `EVM_VAULT_ADDRESS`, `EVM_USER_ADDRESS` so setup
  redeploys.
- **Push + CI**: DONE Session 5 — `port/erc20-vault` pushed, draft PR #1 open
  (https://github.com/sig-net/midnight-examples/pull/1). CI ran and is RED at
  `yarn install` on the `@sig-net/midnight-contract-deploy` npm 404 — the
  EXPECTED P2 state (every step before install green, incl. the rc-toolchain
  install on a fresh runner). Remaining user action: after the publish lands,
  re-run the PR's CI and confirm green end-to-end (the compile/zk-cache/
  compose/e2e steps have never executed in CI).

## Porting baseline (protocol repo)

- Repo: `~/Projects/github.com/sig-net/midnight-erc20-vault-refactor`
- Branch: `bernard/ci-hermetic-loop`
- Commit: `524b9c0e28db3d2a7219c864ba783a0af6d060ec`
- Dirty files: `M README.md` (only) — ported from the tree as-is, not stashed.

## Preflight results (Session 1)

- **P1 — SDK publish state:** `@sig-net/midnight` and
  `@sig-net/midnight-contract` both published at **0.0.3** (`latest` = `rc` =
  0.0.3). Tarball-vs-local comparison: the published 0.0.3 tarballs were built
  at protocol commit `dfdfbda` ("bump npm versions"), which is the **most
  recent commit touching either package** (verified:
  `git log dfdfbda..HEAD -- packages/signet-midnight packages/signet-contract`
  is empty; `src/circuits.compact` in the `@sig-net/midnight` tarball is
  byte-identical to the local file; module lists identical 1:1). The
  big-endian calldata decoding behavior is present in the published source.
  **Conclusion: the vault example does NOT need unpublished SDK behavior — no
  yarn link needed for these two; committed manifests use `^0.0.3` resolved
  from npm.** (The "newer unpublished work" TASK.md warns about lives in the
  old MVP checkout, not in this refactor-repo baseline.)
- **P2 — `@sig-net/midnight-contract-deploy`:** npm 404 confirmed. Follow-up
  recorded above; link work starts in Session 3 (nothing in Phases 0–1
  depends on it).
- **P3 — toolchain/images:** corepack 0.35.0, compact CLI 0.5.1 (compiler
  0.33.0), node v24.18.0, docker 29.6.1. All five compose images already
  pulled locally (proof-server:9.0.0-rc.3, indexer-standalone:4.4.0-pre-alpha.16-…,
  midnight-node:2.0.0-rc.3, foundry:v1.5.1, fakenet:latest). **Gotcha:** a
  bare `compact update` DOWNGRADES the default toolchain to the stable channel
  (0.31.1) — this machine needs 0.33.0-rc.0 (the rc compiler matching the
  ledger-9 prerelease stack; rc builds are not on the launcher's stable
  channel). Session 1 hit this and restored with `compact update 0.33.0-rc.0`.
  Never run a bare `compact update` here until a ≥0.33 stable exists.
- **P4 — prerelease carries:** carried exactly from source manifests:
  `@midnight-ntwrk/compact-js{,-node}@2.5.5-rc.5`,
  `@midnight-ntwrk/midnight-js@5.0.0-beta.3`,
  `@midnight-ntwrk/midnight-js-http-client-proof-provider@5.0.0-beta.3`,
  `@midnightntwrk/ledger-v9@1.0.0-rc.3`,
  `@midnightntwrk/wallet-sdk-abstractions@3.0.0-beta.0`,
  `@midnightntwrk/wallet-sdk-address-format@4.0.0-beta.2`,
  `@midnightntwrk/wallet-sdk-dust-wallet@5.0.0-beta.2`,
  `@midnightntwrk/wallet-sdk-facade@5.0.0-beta.2`,
  `@midnightntwrk/wallet-sdk-hd@3.1.0-beta.1`,
  `@midnightntwrk/wallet-sdk-shielded@4.0.0-beta.2`,
  `@midnightntwrk/wallet-sdk-unshielded-wallet@4.0.0-beta.2`; root
  `resolutions` carried: ledger-v9 1.0.0-rc.3, onchain-runtime-v4 4.0.0-rc.2,
  wallet-sdk-address-format 4.0.0-beta.2. Also carried (Phase 2 will need):
  `@midnight-ntwrk/compact-runtime@0.18.0-rc.0`,
  `@midnight-ntwrk/midnight-js-types@5.0.0-beta.3`.

## Decisions & classifications (do not re-derive)

- **lib export audit (Phase 1):** every export's consumers were grepped across
  the protocol repo. Dropped in transit (dead here — consumers stay in the
  protocol repo or don't exist):
  - `createProofServerProvider` (only consumer: xcontract-events, which stays)
  - `makeVacantCompiledContract` (consumers: signet-contract-deploy +
    xcontract-events, both stay; re-add if a witness-less example contract
    ever lands here)
  - `deriveAddresses` (zero consumers anywhere)
  - `generateMnemonic` (zero consumers outside lib's own test; the test case
    now uses a hardcoded valid 24-word mnemonic)
  - `indexerWsUrlFromIndexerUrl` kept but **unexported** (internal to
    `getMidnightNodeConfig`).
  Everything else is runtime-facing (deploy scripts / flows / cli use it) and
  ported to `packages/lib`. Nothing in lib classified as test-harness-only.
- **`SeedFormat` converted from const-object+union to a TS `enum`** per this
  repo's AGENTS.md enum rule (it is NOT a Compact-twin, so the protocol repo's
  const-object convention doesn't apply here).
- **`standalone.env.example` not carried as a file:** its four `APP__INFRA__*`
  dev constants are inlined into the compose `indexer` service `environment:`
  block (TASK.md scaffolding table amended in the same commit).
- **typescript resolved to `^7.0.2`** (latest stable — the native compiler
  line; protocol repo was on 6.x). It typechecks this workspace correctly
  (verified with a deliberate type-error canary). Every future member uses the
  same `^7.0.2` per the shared-version corollary.
- **`@midnightntwrk/wallet-sdk-address-format` is NOT a lib dependency** (its
  only user was the dropped `deriveAddresses`); the root `resolutions` pin
  for it stays (it arrives transitively via the facade).

## Session 1 — 2026-07-16 — Preflight P1–P4 + Phase 0 + Phase 1

- Status: Phase 0 COMPLETE, Phase 1 COMPLETE (both green: `yarn build && yarn test`, 10/10 lib tests)
- Commits (examples repo, branch `port/erc20-vault`):
  - `1cac587` port: Phase 0 scaffold — root manifests, compose stack, env example, HANDOFF
  - `625f5b7` port: Phase 1 — packages/lib runtime helpers with tests
  - (protocol repo: no commits — untouched, still dirty `M README.md` only)
- Deviations from TASK.md: standalone.env.example dissolved into compose
  indexer environment (table amended in `1cac587`); lib exports dropped per
  the consumer audit above (recorded under Decisions); no other deviations.
- Active yarn links: **none** (P1 concluded npm 0.0.3 suffices; the P2 link
  for `@sig-net/midnight-contract-deploy` is first needed in Session 3 —
  remember to link its unpublished workspace dep `@midnight-erc20-vault/lib`
  too).
- Environment state: the PROTOCOL repo's compose stack is up (5 containers:
  midnight-node, midnight-indexer, midnight-proof-server, local-evm,
  fakenet-responder) — left untouched. The examples repo's compose file uses
  the SAME container names, so both stacks cannot run at once; Sessions 3+
  must `docker compose down` in the protocol repo first (or reuse the running
  stack — images/tags are identical). No zk keys compiled here yet. Nothing
  running in background. Compact toolchain default: 0.33.0-rc.0 (see P3
  gotcha — never bare `compact update`).
- Discovered gotchas: (1) bare `compact update` downgrades to stable 0.31.1 —
  restore with `compact update 0.33.0-rc.0`; (2) `yarn install` emits YN0002
  peer warnings for @effect/platform-node's optional peers — same as the
  source repo, harmless; (3) root `.gitignore` `src/managed/` pattern must be
  written `**/src/managed/` (a mid-pattern slash anchors to the repo root).
- Next session first action: Session 2 (Phase 2, vault contract). Start by
  reading `packages/vault-contract/` in the protocol repo; scaffold
  `examples/erc20-vault/contract` with deps `@sig-net/midnight@^0.0.3` (npm),
  `@midnight-ntwrk/compact-runtime@0.18.0-rc.0`, and run
  `yarn compile` (skip-zk) before typechecking. Expect `compile:zk` to take
  ~10 min — background it early.

## Session 2 — 2026-07-16 — Phase 2 (vault contract)

- Status: Phase 2 COMPLETE (green: `yarn build && yarn test` from root; 50/50
  contract tests incl. the 2 deploy-tx tests running against real zk keys;
  env-agnostic audit clean — only grep hit is the word "path" in a JSDoc
  sentence, not an API).
- Commits (examples repo, branch `port/erc20-vault`):
  - `c8f8b9b` port: Phase 2 — erc20-vault contract package with simulator +
    deploy-tx tests
  - (protocol repo: no commits — untouched, still dirty `M README.md` only)
- Deviations from TASK.md (tables amended in `c8f8b9b`):
  - **`@sig-net/midnight-contract@^0.0.3` added as a third dependency** (the
    table said midnight + compact runtime only): the GENERATED vault code
    imports the callee module `../../SignetNotifier/contract/index.js` at
    runtime, satisfied by the compile-script symlink
    `src/managed/SignetNotifier -> ../../../../../node_modules/@sig-net/midnight-contract/dist/managed`
    (the published tarball ships the compiled contract module AND the signet
    zk keys — the cross-contract proof provider's key source for Phase 4).
    It is part of the Signature Network SDK per AGENTS.md, so within spirit.
  - **`src/providers.ts` dropped, not folded**: the deploy flow doesn't use
    it. `buildVaultProviders`/`VaultProviders`/`VAULT_PRIVATE_STATE_ID`/
    `vaultCompiledContract` must be re-ported in Phase 4 (destination:
    example integration-tests, Node-side) from the protocol repo's
    `packages/vault-contract/src/providers.ts`.
  - **`deployVault` is no longer an export**: deploy-vault.ts folded into
    `deploy.ts`, a self-executing entrypoint outside the export surface (per
    AGENTS.md). The OLD integration-tests imported it in-process
    (`setup/steps.ts`); Sessions 3/4 must run
    `yarn workspace @midnight-examples/erc20-vault-contract deploy` as a
    subprocess step instead (harness owns subprocess helpers), or revisit
    with the orchestrator if in-process proves necessary.
- Active yarn links: none (npm 0.0.3 packages suffice for Phase 2; the P2
  link for `@sig-net/midnight-contract-deploy` is first needed in Session 3).
- Environment state: PROTOCOL repo's compose stack still up (5 containers),
  untouched. zk keys compiled for `examples/erc20-vault/contract`
  (src/managed gitignored — NOTE: a root `yarn compile` re-runs skip-zk and
  the keys survive only until the managed dir is regenerated; re-run
  `compile:zk` if deploy tests report SKIPPED). Nothing running in background.
  Compact toolchain still 0.33.0-rc.0.
- Discovered gotchas: (1) `compact compile` (both modes) rewrites the whole
  managed dir and emits `contract/index.*` LAST — don't typecheck or test
  mid-compile (first build attempt failed on the missing module while zk
  keygen was still running); (2) the published @sig-net/midnight-contract
  manifest exports `./managed/*` -> `./dist/managed/*`, so tests import the
  callee as `@sig-net/midnight-contract/managed/contract/index.js` — same
  realpath as the symlink route, so no dual-module instance; (3) vitest warns
  "Sourcemap ... points to missing source files" for the generated
  contract/index.js — cosmetic, present in the protocol repo too.
- Next session first action: Session 3 (Phase 3, test-harness). Start by
  `yarn link` the protocol checkout's `@sig-net/midnight-contract-deploy` AND
  its unpublished workspace dep `@midnight-erc20-vault/lib` (P2 — record
  links, keep them out of commits), then port
  `packages/integration-tests/src/{e2e-env,env-file,output,preflight,waitForGo,flow-hooks}.ts`
  and `src/setup/{global-setup,local-evm,mpc-keys}.ts` per the map. Remember
  the vault deploy step must shell out to the contract package's `yarn deploy`
  (see deviation above).

## Session 3 — 2026-07-16 — Phase 3 (test-harness)

- Status: Phase 3 COMPLETE (green: `yarn build && yarn test` from root — lib
  10/10, contract 48 passed + 2 deploy-tx skipped (no zk keys compiled, the
  recorded Session 2 state), harness 11/11; smoke gate passed: compose up →
  node/indexer/proof-server/EVM all reachable → compose down).
- Commits (examples repo, branch `port/erc20-vault`):
  - `671275a` port: Phase 3 — test-harness package (setup pipeline, generic
    steps, session, EVM/MPC helpers) [TASK.md tables amended in same commit]
  - (this HANDOFF entry's commit)
  - (protocol repo: no commits — untouched; note its own `cae104b` landed
    before this session, README-only)
- Deviations from TASK.md (tables amended in `671275a`):
  - `src/subprocess.ts` KEPT (renamed `exec.ts`), not deleted: setup steps
    still shell out (docker compose, zk-compile root scripts, and Phase 4's
    vault deploy subprocess per Session 2's deviation). Flows stay in-process.
  - `setup/global-setup.ts` → `setup-pipeline.ts`: harness exports
    `SetupStep` + `runSetupPipeline`; the named STEPS list is the example's
    (Phase 4). `provided-context.ts` holds the vitest ProvidedContext
    augmentation, side-effect-imported by setup-pipeline.ts AND flow-hooks.ts
    (an augmentation only reaches a program through an import chain).
  - `session.ts` split: harness got `createE2eSession({ env,
    requesterAddressEnvVar })` (lazy synced wallet + lazy
    SignetRequestResponseReader + stop) and `resolveUserSeed` (USER_SEED
    default — first piece of the cli-config dissolution). Vault context
    (providers + joined contract + identity) → Phase 4.
  - `steps.ts` split: generic steps in harness, parameterized (token-deploy
    callback, contract-address env-var lists, funded-address list, pipeline
    keys). Vault steps (`deployVaultContractStep`, `ensureVaultEvmAddress`,
    `ensureUserEvmAddress`) + `PIPELINE_KEYS` → Phase 4. NO signet zk-compile
    step exists here: signet keys come with the deploy package (see gotcha 3).
  - Sepolia dropped in transit (out of scope): `SEPOLIA_USDC_ADDRESS`,
    `WellKnownEvmChainId.Sepolia`, the Sepolia ERC20 defaulting.
  - `buildBaseEnv`'s `VITE_TEST_EVM_RPC_URL`→`EVM_RPC_URL` mapping dropped —
    dead here (Session 1's `.env.example` uses `EVM_RPC_URL` directly).
  - hardhat judgment call: hardhat.config.ts + `hardhat` +
    `@openzeppelin/contracts` + TestUSDC.sol ALL go to the example's
    integration-tests (Phase 4); harness is hardhat-free and instead exports
    the generic `deployEvmContract(rpcUrl, artifact)` + funding helpers.
  - `@sig-net/midnight-contract-deploy` committed range chosen as `^0.0.3`
    (lockstep with the sibling SDK packages); verify at publish time.
- Active yarn links (NOT committed — re-create after pulls): root
  `package.json` `resolutions` carries this uncommitted hunk:
  - `"@sig-net/midnight-contract-deploy": "portal:<protocol>/packages/signet-contract-deploy"`
  - `"@midnight-erc20-vault/lib": "portal:<protocol>/packages/lib"`
  - `"@effect/platform-node": "0.107.0"`, `"@effect/platform": "0.96.2"`,
    `"effect": "3.21.4"` — link-era ONLY: the portal's files typecheck
    against the PROTOCOL checkout's node_modules, and TS dedupes same-version
    packages by package-ID across the two trees; any version skew in a shared
    dep mixes two type identities inside one file (see gotcha 1). Remove all
    five lines together when the publish lands.
  (`<protocol>` = /Users/bernard/Projects/github.com/sig-net/midnight-erc20-vault-refactor;
  recreate with `yarn link --private <protocol>/packages/signet-contract-deploy
  <protocol>/packages/lib` + re-add the three pins by hand. yarn.lock is
  gitignored in this repo, so lockfile hygiene is a non-issue.)
- Environment state: PROTOCOL repo's compose stack recreated FRESH by the
  smoke-gate takeover (5 containers up: node, indexer, proof-server,
  local-evm, fakenet-responder) — chain state reset, protocol `.env`
  addresses stale (see FOLLOW-UPS). Examples repo's stack DOWN (smoke tears
  down). Vault contract zk keys NOT compiled (src/managed is skip-zk output;
  deploy-tx tests skip). Nothing running in background. Compact toolchain
  still 0.33.0-rc.0.
- Discovered gotchas:
  1. **Portal typechecking mixes dependency trees.** The portal'd sources
     resolve imports from the PROTOCOL repo's node_modules (realpath), while
     same-version packages (e.g. compact-js 2.5.5-rc.5) dedupe by TS
     package-ID against OUR copies — typed against OUR `effect`. With
     protocol at effect 3.21.4 and us at 3.22.0, `Layer`/`Tag` type
     identities split INSIDE the portal's own files ("missing [EffectTypeId]"
     errors in code that is green in its home repo). Fix: pin the divergent
     shared deps (`effect`, `@effect/platform`, `@effect/platform-node`) to
     the protocol tree's exact versions in the uncommitted resolutions hunk.
     Diagnose with `tsc --traceResolution`.
  2. Yarn 4 `yarn link` refuses private targets without `--private`.
  3. Via the portal, `deploySignetContract` reads the signet contract's
     PROVER keys from `<protocol>/packages/signet-contract/src/managed`
     (path resolved relative to the deploy package's real location). They
     exist there today; if that managed dir is ever wiped, run
     `yarn compile:signet-contract:zk` in the PROTOCOL repo before the
     harness setup's deploy step.
  4. Both repos' compose stacks share container names — `docker compose up`
     for one requires `docker compose down` (not `stop`) for the other, which
     destroys chain state. Plan takeovers deliberately; record them.
- Next session first action: Session 4 (Phase 4a). Bring the examples stack
  up (`docker compose down` in the protocol repo first — see gotcha 4), then
  scaffold `examples/erc20-vault/integration-tests`: vault halves from the
  amended TASK.md tables (STEPS list + PIPELINE_KEYS + vault setup steps +
  vault session context via `buildVaultProviders` re-port), TestUSDC.sol +
  hardhat compile, flows (deposit/withdraw), `happy-day-e2e` spec rewired
  in-process, vitest.config with globalSetup → its own setup file composing
  harness steps. Vault deploy step = subprocess
  `yarn workspace @midnight-examples/erc20-vault-contract deploy` (capture
  the printed address) wrapped in `retryDeployWhileDustGenerates`; run
  `compile:zk` for the vault contract early (~10 min, background it).

## Session 4 — 2026-07-16 — Phase 4a (integration-tests: flows + vault helpers + setup + happy-day e2e GREEN)

- Status: Phase 4a COMPLETE. `happy-day-e2e` GREEN against the local stack in
  ONE run from a FRESH deployment (no pre-existing `.env`): setup pipeline
  16/16 steps (fresh TestUSDC + signet + vault deploys, `.env` auto-created,
  responder auto-started), flow tests 15/15 passed, exit 0. Flow-test wall
  clock 391.6s; whole invocation ≈22 min (vault zk compile skipped via
  TRUST_PREBUILT_ZK_KEYS=1 — this session had just compiled the keys from
  current sources in the background; a cold run adds ~10 min). Root
  `yarn build && yarn test` green offline: contract 50/50 (deploy-tx tests
  ran against the fresh zk keys), lib 10/10, harness 11/11, integration
  suite 15 skipped (RUN_INTEGRATION_TESTS gating verified).
- Commits (examples repo, branch `port/erc20-vault`):
  - `e170e97` port: Phase 4a — erc20-vault integration-tests package (flows,
    vault context/providers, setup pipeline, happy-day spec) [TASK.md tables
    amended in same commit]
  - `d5690ca` port: default EVM_RPC_URL to the local compose evm service in
    the vault setup
  - (this HANDOFF entry's commit)
  - (protocol repo: no commits — untouched, clean at `cae104b`)
- Deviations from TASK.md (tables amended in `e170e97`):
  - **CLI commands → per-verb flow files** `src/flows/{initialize,deposit,
    claim,withdraw,complete-withdraw,broadcast-evm,poll-signature-response,
    poll-respond-bidirectional}.ts`; `read-state` folded into
    `src/vault-ledger.ts` (`printVaultState`, provider+address args so the
    script can drive it wallet-free). `runDepositRoundTrip` lives in
    `flows/deposit.ts` (consumers: Session 5's specs).
  - **Old flows/withdraw.ts legs DISSOLVED** (they only wrapped cli calls);
    Session 5's failure-refund spec calls the primitives + polls directly.
  - **cli config/context → `src/vault-context.ts`**: `VaultContext` with ALL
    fields required (incl. `evmUserAddress`/`evmVaultAddress`; the setup
    pipeline populates everything) — `requireConfigValue` gone; the cli's
    separate `midnightProviders.indexerPublicDataProvider` dropped
    (duplicate of `providers.publicDataProvider`, same construction;
    `createResponseReader(context)` uses the latter).
  - **cli identity.ts split**: parsing = lib `parseIdentitySecretKey`
    (existed since Phase 1); derivation (userCommitment circuit + signet
    path) = example `src/vault-identity.ts` (`resolveUserIdentity(env)`).
  - **scripts/ = `read-state.ts` ONLY** (wallet-free, indexer-only; run
    `yarn workspace @midnight-examples/erc20-vault-integration-tests
    read-state`). Dropped as hand-drive scripts: initialize, deposit, claim,
    withdraw, complete-withdraw, broadcast-evm, both polls — each needs a
    synced wallet (minutes of startup) and is driven through the specs +
    resume vars (`DEPOSIT_REQUEST_ID`/`WITHDRAW_REQUEST_ID`) instead.
  - **Root scripts added early** (Phase 5 owns the rest):
    `compile:erc20-vault`, `compile:erc20-vault:zk` (the setup's zk-compile
    step shells out to it), `test:erc20-vault:e2e`.
  - **EVM_RPC_URL now defaults** to `http://127.0.0.1:8545` in the example's
    setup (`d5690ca`): .env.example's header already promised local-stack
    defaults; it was the one value without one and broke the zero-.env
    fresh-clone path (first live run failed on it).
  - vitest.config ports the protocol's PipelineSequencer with
    FILE_ORDER=[happy-day] only; Session 5 appends the other four specs.
- Earlier-phase files touched: NONE in lib/contract/harness src. Only root
  `package.json` (scripts) and `.env.example` (comment wording for the new
  default).
- Active yarn links (NOT committed — unchanged from Session 3, re-create
  after pulls per Session 3's Active-links entry): resolutions carries
  `@sig-net/midnight-contract-deploy` + `@midnight-erc20-vault/lib` portals
  to the protocol checkout plus the three link-era effect pins.
- Environment state: EXAMPLES repo compose stack UP under project
  `midnight-examples` — 5 containers: node, indexer, proof-server, local-evm,
  fakenet-responder (started by the setup hand-off, healthy: "polling signet
  contract registry at c50831…"). PROTOCOL repo stack DOWN (taken over this
  session; its chain state destroyed again — FOLLOW-UPS note about stale
  protocol `.env` addresses still applies). Examples repo-root `.env` now
  EXISTS: setup appended MPC_ROOT_KEY + MIDNIGHT_SIGNET_CONTRACT_ADDRESS;
  Session 4 appended the rest of the printed pipeline block (operator
  convention), so the NEXT run is a RERUN against kept contracts
  (deploys/compiles all SKIP; happy-day is rerun-tolerant end to end).
  Deployed this run: signet c508313498449baa8a19ae3d7aa7a26950258341194363ebf791aa1247da42f7,
  vault 85af3e48371e698e52f68ee96c72b1e6a1a449e42b5347a895bcd078bf6b5e81,
  TestUSDC 0x5FbDB2315678afecb367f032d93F642f64180aa3 (chain 31337).
  Vault zk keys compiled (src/managed, gitignored). Nothing running in
  background. Compact toolchain still 0.33.0-rc.0.
- Discovered gotchas:
  1. **Profiled compose services survive plain `docker compose down`** — the
     protocol repo's fakenet-responder needed
     `docker compose --profile fakenet down`; a leftover profiled container
     blocks the network removal AND collides with the other repo's stack.
  2. **The claim proof peaked at ~12.5 GiB proof-server RSS** on a 15.6 GiB
     Docker VM — passed, but it is the OOM candidate the Risks section
     predicts; keep the resume-var playbook handy for Session 5's specs.
  3. The vault deploy subprocess (`yarn workspace …contract deploy` via
     harness `runCommand`) works as designed: address captured from the
     `deployed erc20-vault at <addr>` line; a transient InsufficientFunds
     failure would surface in the subprocess error tail, which
     `retryDeployWhileDustGenerates`'s matcher still catches.
  4. vitest prints a misleading `No test files found, exiting with code 1`
     when globalSetup THROWS — the real error is the `Unhandled Error` block
     below it; don't chase the test-discovery red herring.
  5. This harness's bash cwd resets between tool calls — `yarn` invocations
     without an explicit `cd` can land in the WRONG repo silently (one
     stray `yarn test` ran in the old MVP checkout; harmless, nothing
     written). Always `cd` explicitly in compound commands.
- Next session first action: Session 5 (Phase 4b + Phase 5). The stack is UP
  and `.env` holds the full pipeline block, so
  `TRUST_PREBUILT_ZK_KEYS` is irrelevant and `yarn test:erc20-vault:e2e`
  reruns happy-day against kept contracts in ~7 min — run that first as a
  baseline, then port the remaining four specs
  (`deposit-withdrawal-failure-refund`, `deposit-claimant-not-caller`,
  `benchmark`, `false-claimer`) from the protocol repo's tests/, rewiring
  cli-command calls to `src/flows/` functions (use `runDepositRoundTrip` +
  `drainVaultErc20`; the withdraw legs are gone — call
  withdraw/completeWithdraw/polls directly) and appending each file to
  vitest.config's FILE_ORDER. Then Phase 5: remaining root scripts, CI
  workflows, `/e2e` skill draft per TASK.md's spec.

## Session 5 — 2026-07-16 — Phase 4b (four e2e specs + example README) + Phase 5 (root scripts, CI, /e2e skill)

- Status: Phase 4b COMPLETE, Phase 5 COMPLETE. ALL FIVE e2e specs green
  against the local stack (kept contracts), 49 tests total:
  happy-day 15/15 (181.5s resumed pass; also passed inside the one
  full-suite invocation), deposit-withdrawal-failure-refund 9/9 (183.7s
  resumed pass), deposit-claimant-not-caller 6/6 (175.9s), benchmark 13/13
  (291.3s, full BENCHMARK_TIMINGS_JSON line — no legs skipped),
  false-claimer 6/6 (169.4s). Root `yarn build && yarn test` green offline
  (5 e2e files / 49 tests skip cleanly). CI ran on PR #1 and is red ONLY at
  the expected P2 npm 404 (see FOLLOW-UPS).
- Commits (examples repo, branch `port/erc20-vault`, pushed):
  - `2c2e858` port: Phase 4b — remaining four e2e specs rewired in-process +
    example README
  - `e5a5586` port: Phase 5 — root scripts, CI workflows, /e2e skill
  - (this HANDOFF entry's commit)
  - (protocol repo: no commits — untouched, clean at `cae104b`)
- Deviations from TASK.md: none requiring table amendments. Judgment calls:
  - The member script `test:e2e:happy-day-e2e` (Session 4) REMOVED: extra
    args forward through the root script (verified:
    `yarn test:erc20-vault:e2e tests/<file>` selects that file) — one
    mechanism for per-spec runs, used by CI's gate step and the skill.
  - "ALL FIVE specs pass" gate met via one full-suite invocation (happy-day
    passed; failure-refund OOM'd the proof server at its arrange claim) +
    the TASK-sanctioned resume playbook for the rest, run per-spec with a
    proof-server restart between files. A zero-intervention single-run full
    suite is NOT reliably achievable on a 16 GB Docker VM — the OOM hit the
    claim leg twice today (also once on the plain happy-day baseline rerun).
    The skill documents the restart-between-files cadence.
  - CI: reusable workflow takes `example-dir` + `full-suite` + `gate-spec`
    inputs; PR gate runs happy-day only (protocol repo precedent — wall
    clock + runner-RAM), full suite via workflow_dispatch. Paths filter also
    covers root package.json + tsconfig.base.json (root scripts/config drive
    everything). actionlint clean (docker rhysd/actionlint).
  - Architecture doc folded into `examples/erc20-vault/README.md`; the
    drawio SVG copied to `examples/erc20-vault/docs/` (protocol repo copy
    untouched — deletion is Phase 8).
- Active yarn links (NOT committed — unchanged from Session 3, re-create
  after pulls per Session 3's Active-links entry): resolutions carries
  `@sig-net/midnight-contract-deploy` + `@midnight-erc20-vault/lib` portals
  plus the three link-era effect pins. The Phase 5 root-scripts commit was
  staged by temporarily stripping the hunk and restoring it after — the
  committed package.json has clean resolutions.
- Environment state: EXAMPLES stack UP (5 containers: node, indexer,
  proof-server, local-evm, fakenet-responder; responder healthy and polling
  signet c508313…). PROTOCOL stack DOWN. `.env` unchanged (full pipeline
  block, kept contracts; no resume vars persisted). Vault zk keys compiled
  (src/managed). Nothing running in background. Compact toolchain
  0.33.0-rc.0. Branch pushed; draft PR #1 open.
- Discovered gotchas:
  1. `vitest run` IGNORES `--version` and runs the whole suite — never
     "probe" the e2e script; a second vitest against the same stack collides
     with an in-flight run (shared midnight-level-db wallet state) and adds
     memory pressure. Verify arg-forwarding with the OFFLINE `test` script.
  2. The proof-server OOM (Exited 137, OOMKilled=true) is now 2-for-2 on
     claim legs that follow other proofs on the same server instance —
     including a plain kept-contracts happy-day rerun. Treat
     restart-proof-server-between-spec-files as the DEFAULT cadence on a
     16 GB VM, not just OOM recovery.
  3. Session 4's cwd-reset gotcha recurred: a background `yarn` without an
     explicit `cd` ran in the WRONG repo (old MVP checkout, yarn 1.x,
     "Command not found" — harmless but wasted a run). ALWAYS `cd` first in
     backgrounded compound commands.
- Next session first action: Session 6 (Phase 6). Fresh-clone the repo to a
  NEW directory, re-create the two yarn links + three effect pins there
  (P2), then follow `.claude/skills/e2e/SKILL.md` VERBATIM from the top
  (corepack → install → compact update → compile:zk backgrounded → compose
  up → full suite) — every divergence found is a skill bug to fix
  in-session. NOTE for the verbatim run: a bare `compact update` on this
  MACHINE is safe only because 0.33.0-rc.0 is already the default; on a
  truly fresh machine the skill's `compact update` line installs stable and
  the compile will reject the pragma — expect to hit this divergence and fix
  the skill (the CI workflow's LFDT rc-download recipe is the reference).
  Also expect the OOM cadence (gotcha 2) during the full suite.

## Session 6 — 2026-07-16 — Phase 6 (fresh-clone full verification, /e2e skill verbatim)

- Status: Phase 6 COMPLETE. All five e2e specs green from a FRESH CLONE
  (cloned `origin/port/erc20-vault` @ `6ef1ce2` into a scratchpad dir),
  following `.claude/skills/e2e/SKILL.md` VERBATIM as an agent that had
  never seen the repo; full unit suite green in the clone (`yarn build &&
  yarn test`: contract 50/50 incl. deploy-tx against the fresh zk keys,
  lib 10/10, harness 11/11, e2e 5 files/49 tests skipped offline).
  Run evidence: first invocation (no `.env`, fresh deploys) 18.3 min wall
  (14:15:59→14:34:16) — setup 16/16 (fresh TestUSDC 0x5FbD…, signet
  dbe0b52f…, vault 015785…, responder auto-started and healthy), happy-day
  15/15, deposit-withdrawal-failure-refund 9/9, deposit-claimant-not-caller
  6/6, then proof-server OOM (Exited 137, OOMKilled=true) at benchmark's
  deposit PROVE; recovery per the skill's playbook: restart + plain rerun →
  benchmark 13/13 (284.0s, full BENCHMARK_TIMINGS_JSON), restart →
  false-claimer 6/6 (184.8s). 49/49 e2e total.
- Commits (examples repo, branch `port/erc20-vault`, pushed):
  - `a1b43bb` port: Phase 6 — /e2e skill fixes from the fresh-clone verbatim run (rebased over the user's `84c6e97` readme updates)
  - (this HANDOFF entry's commit)
  - (protocol repo: no commits — untouched, clean at `cae104b`)
- Deviations from TASK.md: none (no table amendments needed). The gate's
  real output is the skill-divergence list, all fixed in `a1b43bb`:
  1. No P2 interim note — a truly fresh `yarn install` 404s on
     `@sig-net/midnight-contract-deploy` (reproduced); quickstart now
     carries the "until published" yarn-link bridge recipe.
  2. Bare `compact update` installs — and DOWNGRADES an active rc default
     to — stable 0.31.1, and the compile then fails `language version
     0.23.0 mismatch` (both observed); quickstart now says
     `compact update 0.33.0-rc.0` with the CI workflow's direct-download
     recipe as fallback reference.
  3. The quickstart's standalone `compile:erc20-vault:zk` was redundant:
     the setup's skip conditions (address env var / TRUST_PREBUILT_ZK_KEYS)
     never hold on a fresh clone, so it recompiled regardless — keygen paid
     twice (observed). Step removed; first-invocation wall clock documented.
  4. "Fresh deploy runs green in ONE pass" read as whole-suite-one-run;
     clarified (deploy pipeline yes; flow files expect the OOM interrupt)
     and restart-between-spec-files documented as the DEFAULT cadence on a
     16 GB VM (OOM now 3-for-3 across Sessions 5–6).
  5. OOM playbook extended: an OOM can kill the PROVE itself (benchmark
     deposit leg this run) — no request-id banner printed means nothing to
     resume; rerun the spec plain.
  Example README timings checked against this session's numbers: accurate
  as written, no correction needed.
- Active yarn links (NOT committed): BOTH checkouts now carry the same
  uncommitted resolutions hunk — the two portals
  (`@sig-net/midnight-contract-deploy`, `@midnight-erc20-vault/lib` →
  protocol checkout) plus the three effect pins — primary unchanged from
  Session 3, clone re-created this session per Session 3's Active-links
  entry. Re-create after pulls as before.
- Environment state: the CLONE's compose stack is UP (5 containers; the
  shared container names now belong to compose project
  `midnight-examples-fresh`; responder healthy, polling signet dbe0b52f…).
  PRIMARY checkout's stack DOWN (taken over this session with
  `--profile fakenet down` — chain state destroyed again): the primary
  `.env`'s Session-4 addresses (signet c50831…, vault 85af3e…) are STALE.
  The clone's contracts live on the CURRENTLY RUNNING chain, so the primary
  can adopt the clone's printed `.env` block instead of redeploying — or
  comment out its contract-address vars for a fresh redeploy. Clone
  location: the session scratchpad
  (`…/scratchpad/midnight-examples-fresh`) — left in place, stack up,
  `.env` holding the full current pipeline block; NOTE the scratchpad is
  session-scoped, so treat the clone as disposable (branch state is fully
  pushed; only the running stack + its `.env` matter, and only until the
  next takeover). Vault zk keys compiled in the clone. Nothing running in
  background. Compact toolchain default 0.33.0-rc.0 (restored after the
  verbatim run's deliberate bare-`compact update` downgrade).
- Discovered gotchas: (1) the setup's in-run zk keygen took ~3 min on this
  machine vs ~12 min for the standalone pre-compile earlier the same hour —
  keygen wall clock varies widely; don't diagnose a hang from duration
  alone. (2) An OOM can hit a file's first deposit PROVE (not just claim
  legs) when earlier spec files exhausted the same server instance — and a
  killed prove leaves NO resume id (playbook updated). (3) `docker compose
  up` in a second checkout works with the same container names as long as
  the first checkout's stack was `--profile fakenet down`'d — the
  containers just migrate to the new compose project name.
- Next session first action: Session 7 (Phase 7, protocol repo, branch
  `refactor/split-examples`): the protocol repo's `.env` addresses have
  been stale since Session 3 (see FOLLOW-UPS) and the chain was reset again
  this session — take the stack over from the protocol checkout
  (`docker compose --profile fakenet down` in the CLONE dir first), comment
  out the protocol `.env`'s contract-address vars so its setup redeploys,
  then build `packages/caller-contract` + the generic e2e per TASK.md
  Phase 7.
