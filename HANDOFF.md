# HANDOFF — erc20-vault port, session-to-session state

Read TASK.md first; this file records what each session actually did, the
running follow-ups list, and the decisions the next session must not re-derive.

## FOLLOW-UPS (pending user actions)

- **Publish `@sig-net/midnight-contract-deploy` to npm** (currently 404 — P2).
  Until then Session 3+ must `yarn link` it (AND its workspace dep
  `@midnight-erc20-vault/lib`, which is also unpublished — a portal's deps
  resolve in the consuming project) from the protocol checkout. After publish:
  remove the links, re-run Phase 6 verification against npm.
- **Protocol repo working tree is dirty**: `M README.md` on
  `bernard/ci-hermetic-loop` — ported from the tree as-is per TASK.md; user
  should commit or discard that hunk in the protocol repo.
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
