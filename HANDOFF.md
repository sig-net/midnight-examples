# HANDOFF — erc20-vault port, session-to-session state

Read TASK.md first; this file records what each session actually did, the
running follow-ups list, and the decisions the next session must not re-derive.

## FOLLOW-UPS (pending user actions)

- **Publish `@sig-net/midnight-contract-deploy` to npm** (currently 404 — P2).
  Session 3 linked it (AND its workspace dep `@midnight-erc20-vault/lib`) from
  the protocol checkout. After publish: remove the links AND the three
  link-era `effect`-family pins from the root resolutions (see Session 3's
  Active-links entry), verify the committed `^0.0.3` range matches the
  actually-published version (bump the harness manifest if not), `yarn
  install`, re-run Phase 6 verification against npm.
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
- **Push + CI**: examples repo remote is `git@github.com:sig-net/midnight-examples.git`;
  Phase 5's "CI green" gate needs the `port/erc20-vault` branch pushed and a PR
  opened.

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
