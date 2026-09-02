# midnight-examples — workspace-wide agent rules

This repository is a single **Yarn workspace** (Yarn 4 via corepack, `nodeLinker:
node-modules`), split between shared machinery and the examples integrators copy:

- **`packages/lib`** — runtime helpers imported by examples (wallet,
  providers, tx build & submit). Kept ruthlessly small.
- **`packages/test-harness`** — test-only machinery (stack bring-up/teardown,
  mpc-keys setup, wallet funding, env/session handling, subprocess helpers).
  Test-only deps live here and never touch an example's manifests.
- **`examples/*/*`** — one directory per example, each holding up to four
  workspace packages: `contract` (required), then `client`, `deploy` and
  `integration-tests` as warranted. Each package holds exactly one kind of
  thing, and the split is by WHAT the code is, never by who happens to call it:
  - `contract` — the Compact contract plus its environment-agnostic client
    surface: witnesses, circuit-id/private-state/provider TYPES, ledger reads,
    and the contract's own constants. Runs unchanged in a browser.
  - `client` — the same client surface's Node half, the part that cannot be
    environment-agnostic: the compiled-contract binding over `managed/`, and a
    live provider set.
  - `deploy` — ONLY deploying and post-deploy initialisation: constructor args,
    the deploy transaction, one-shot init circuits, and the configuration those
    resolve. Anything a client would still need after the deploy is over
    belongs in `contract` or `client`, never here.
  - `integration-tests` — flows and specs.
  An example's flows are typed functions in `integration-tests/src/flows/`, run
  in-process by its tests, and its deploy / init flows are typed functions in
  `deploy/src/`, run in-process by the setup pipeline. Both kinds get thin `tsx`
  entrypoints over those SAME functions for hand-driving a live stack
  (`integration-tests/scripts/` and `deploy/scripts/`) —
  never a subprocess call with its output scraped, which is how the two paths
  silently diverge.

Run `yarn install` from the repo root — never from inside a member. Run
`yarn compile` before `build`/`test`: contract packages typecheck against their
generated `src/managed/` output. The full layout lives in [README.md](README.md).

# Examples-repo identity rules

These three rules are what make this repo work as an *examples* repo. They override
any instinct carried in from product-repo conventions.

- **Examples depend on `@sig-net/midnight` / `@sig-net/midnight-contract` ONLY via
  npm published versions in committed manifests.** An example's `package.json`
  names the SDK as a normal npm semver range — never a `workspace:`, `link:`,
  `portal:`, or `file:` reference back to the protocol repo, and never a
  `resolutions` override pointing at a local checkout. Using `yarn link` (or a
  temporary `portal:`) against a local protocol checkout **is fine — encouraged —
  for local development**; just never commit it. Committed manifests referencing
  published versions are what make the protocol/examples split real, and they make
  this repo's CI a continuous compatibility test of the published packages.
- **Hoist only *boring infra*; duplicate anything *instructive*.** Each example
  must read standalone: an integrator copying `examples/<name>/` should see the
  whole integration without chasing imports. Generic wallet/provider/test plumbing
  belongs in `packages/lib` / `packages/test-harness`; anything protocol-relevant
  belongs in the published SDK, not in either. When in doubt, duplicate in the
  example — readability of the example outranks DRY here. Keep `packages/lib`
  ruthlessly small: every import from it is plumbing an integrator copying an
  example can't see, and it ideally shrinks toward zero as pieces graduate into
  the SDK. Test-only deps (vitest, hardhat, viem) live in
  `packages/test-harness` and never appear in an example's manifests.
- **No workspace package is published by default.** Every member is named
  `@sig-net/midnight-examples-*` and starts `"private": true`. That is the SAME
  npm scope the published SDK uses (`@sig-net/midnight`,
  `@sig-net/midnight-contract`), so the `midnight-examples-` prefix is the only
  thing separating an example from a product package: never drop it, and never
  clear `"private"` without meaning to publish into the SDK's scope. Anything
  else worth publishing graduates to the protocol repo's SDK packages.
  The packages that ARE published today are the erc20-vault trio plus the lib
  they run on: `@sig-net/midnight-examples-lib`,
  `@sig-net/midnight-examples-erc20-vault-{contract,client,deploy}`. They exist
  for downstream example applications that combine many chains. Each drops
  `"private"` and carries `files`, `publishConfig` and a `prepack`; the rest of
  the workspace stays private. A contract package ships no `*.prover`: prover
  keys publish as assets on the example's release tag, the client downloads the
  one circuit it needs and verifies it against the manifest the npm package
  ships, and the assets of a version already on npm are frozen (that manifest
  pins their hashes, and keygen is not byte-reproducible).
- **A published package's intra-workspace deps use `workspace:*`; its SDK deps
  use a fixed npm version.** `workspace:*` resolves to the sibling during
  development and yarn rewrites it to that sibling's EXACT version at pack time,
  which is what keeps a release's packages pinned to each other rather than to
  whatever the registry serves later. This does not soften the rule above that
  an example names `@sig-net/midnight` / `@sig-net/midnight-contract` as a plain
  npm semver range: `workspace:` is only ever for members of THIS repo, never a
  reference back to the protocol repo.
- **Every published package version moves in lockstep with its example's release
  tag.** A release is tagged `<example-dir>-vX.Y.Z` (or `-vX.Y.Z-rc.N`) and the
  publish workflow refuses to run unless every package it publishes is already
  at exactly `X.Y.Z`. Bump them together in the commit that precedes the tag.

Corollary: an example's `contract` package depends on the Signature Network SDK +
compact tooling and **nothing else** — its dependency list is itself documentation
of the minimal integration surface. Test/tooling deps go in that example's
`integration-tests` package or in `packages/test-harness`.

# NEVER BREAK rules

These are non-negotiable. Do not violate them unless the user explicitly grants an
exception for that specific case.

- **Rules here are timeless and standalone — write them in the present tense.** This
  governs every rule in this file, including future additions. State what to do and
  why it is right *now*, never how the codebase got here. NO references to a prior
  repo, an earlier branch, a migration or port in progress, or anything else that
  goes stale. A rule must read correctly to someone who arrives at `main` with no
  memory of how it was built. Concrete rationale and bad-vs-good examples are
  encouraged; historical narrative is not. Keep the lesson, drop the story.
- **NEVER carry dead code.** Unused env vars, disabled or unreachable code paths,
  scaffold leftovers, commented-out blocks — delete them, never leave them for
  "later". Code that isn't reached is a lie about what the system does. In an
  examples repo this is doubly true: dead code in an example teaches integrators
  the wrong integration.
- **ALWAYS install dependencies at FIXED versions; the committed `yarn.lock` is
  the source of truth.** CI installs with `yarn install --immutable`, and an
  upgrade is a deliberate, reviewed change to `package.json` plus `yarn.lock`,
  never a side effect of installing. To add a dependency, first resolve the
  intended version (`yarn npm info <pkg> --fields dist-tags,version,deprecated`),
  then add it exactly: `yarn workspace <workspace> add <pkg>@<version>`.
  `yarn add` writes the range you name verbatim, so naming the bare version is
  what pins it. Never install from the `latest` dist-tag and never leave a
  version free to float. If the version you need is a prerelease
  (`-rc`/`-beta`/`-alpha`/`-next`/`-canary`), STOP and ask the user before
  adopting it. Before you install, confirm the release is not deprecated and
  `yarn npm audit` reports no new advisory. The compact toolchain is likewise
  pinned: install it with `compact update 0.33.0-rc.2` (the exact version named
  in the README's prerequisites), and CI installs exactly that version. The
  toolchain pin lives in several places that move TOGETHER, in EVERY workflow
  that installs the toolchain (`example-test.yaml`, `publish-erc20-vault.yml`
  and `erc20-vault-deploy.yml` all do): each workflow's launcher URL
  (`compact-v0.5.1`) and compiler zip
  URL, the SHA-256 checksums it verifies for those two downloads (recompute
  each from a fresh download of the new URL), the workflow cache keys, and the
  README's Prerequisites table. This trigger is bidirectional: a request to
  "update the compact version" AND a request to edit the version in the README's
  table both mean updating every one of these sites in the same change. Grep
  `.github/workflows/` for the old version rather than editing the workflows you
  happen to remember.
  Corollary: a dependency shared by two members MUST resolve to the same
  version in every member. Bump it everywhere in the same change and
  `yarn install` from the root: a single shared version is what keeps the
  WASM-backed `@midnight-ntwrk/*` packages resolving to one instance, and
  divergence causes dual-instance "expected instance of…" bugs.
- **NEVER emit JavaScript.** Packages export TypeScript source
  (`"." : "./src/index.ts"`); `build` means `tsc` under the base config's `noEmit`.
  No `dist/`, no `tsc --outDir`, no ts-node loaders, no copy steps. Tests run under
  vitest; entrypoints run under `tsx`. If you think you need a build step, stop and
  ask — a build step is a defect in this workspace, not a missing feature.
  **The one exception is publishing:** each npm-published package additionally
  emits `dist/` via a `tsconfig.build.json`, ships ONLY `dist/`
  (`files: ["dist"]`), and swaps its entry to it through `publishConfig.exports`
  at pack time. The emit belongs to `prepack`, never to `build`, so `yarn build`
  keeps meaning "typecheck, no emit" everywhere and the workspace itself always
  resolves raw `src/index.ts`, never `dist/`.
- **ALWAYS finish a change with `yarn format:check && yarn lint && yarn build && yarn test`**
  in the member you touched (or from the root). `tsx` and vitest execute without
  typechecking — "it runs" is NOT verification. If you add a new top-level TS
  directory to a member, add it to that member's tsconfig `include` in the same
  change; a file outside `include` passes silently and then breaks in the IDE —
  and it is also invisible to the type-aware lint rules, which go quiet rather
  than erroring when a file belongs to no tsconfig.
- **Lint and format config lives ONCE at the repo root, and lint runs AFTER
  compile.** `eslint.config.js`, `.prettierrc.json` and `.prettierignore` are
  root-only: `eslint .` from the root already covers every member, and
  per-package copies drift. The type-aware rules read the generated
  `src/managed/` types the source imports, so `yarn lint` needs `yarn compile`
  first exactly as `yarn build` does. NEVER add a per-package `eslint.config.*`
  or `.prettierrc*`.
- **The ESLint config turns NO rule off, and the tree carries NO
  `eslint-disable` directive.** When a rule fires, FIX THE CODE. A config full
  of suppressions is a config fitted to whatever code happens to exist, and it
  licenses the same defect forever; a config with none is a standard the code is
  held to. `reportUnusedDisableDirectives` is set to `error`, so a stale
  suppression fails the build too. The only options the config passes to a rule
  are ones that WIDEN coverage (e.g. `jsdoc/require-jsdoc` reaching types and
  exported consts), teach a rule about an API it predates (e.g.
  `vitest/expect-expect` learning `expectTypeOf`), or pin a purely cosmetic
  house style to what the repo's existing blocks already do (`jsdoc/tag-lines`).
  If you believe a rule genuinely cannot hold, STOP and ask rather than adding
  an `"off"`.
- **Two TypeScripts, on purpose: members build on 7, ESLint reads types through
  a root-only 6.0.3.** Every member pins `typescript@^7.0.2`, the native Go
  compiler `yarn build` runs. TypeScript 7 ships no public compiler API (it is
  scheduled for 7.1), so typescript-eslint declares
  `peerDependencies.typescript: ">=4.8.4 <6.1.0"` and cannot parse `.ts` at all
  under 7 — not merely lose its type-aware rules. The root therefore carries
  `typescript@6.0.3` as a devDependency used ONLY by the lint toolchain, which
  is Microsoft's own documented transition pattern (they publish
  `@typescript/typescript6` for the same purpose). yarn resolves the root to
  6.0.3 and nests 7.0.2 under each member, so `yarn build` keeps the native
  compiler. DELETE the root pin once typescript-eslint supports the 7.1 API;
  until then, do NOT "tidy" the two versions into one, and remember lint's
  checker is a major behind the one that gates the build.
- **`noUncheckedIndexedAccess` is on.** An index read (`arr[i]`, `record[key]`,
  a regex capture group, a `.split()` result) is typed `T | undefined`, so it
  must be narrowed before use. In preference order: iterate instead of indexing
  (`for (const b of bytes.subarray(a, b))` yields `number` and is usually
  shorter); use `.at(i)` with an explicit `throw`; hoist the lookup and fold its
  undefined check into a throw the code already performs. NEVER reach for `!` —
  `no-non-null-assertion` is on, so a bang only moves the problem. In a test,
  `expect(xs).toHaveLength(1)` does NOT narrow the `xs[0]` that follows it: add
  a small local helper that throws when the element is missing, and keep the
  `toHaveLength` assertion visible in the test itself.
- **NEVER commit generated compiler output.** Each contract package's
  `src/managed/` is produced by `yarn compile` and is gitignored. Default
  compile is `--skip-zk` (fast; enough for typecheck + simulator tests); run
  `compile:zk` only when proving keys are actually needed (real deploys,
  integration tests).
- **Unit tests are simulator-only.** A contract package's `tests/` run entirely
  in-process via `@midnight-ntwrk/compact-runtime` — no network, no docker, no
  proof server. Anything that needs a running stack belongs in that example's
  `integration-tests` package, nowhere else.
- **Tests must read at a glance — table-driven over helper-driven.** A reader must
  see a test's inputs and expected outcome in the test itself (or its table row)
  without tracing helper functions. Concretely:
  - When one function under test has many input → error/output cases, write ONE
    typed case table + `it.each`, not N copy-pasted `it` blocks.
  - Long-hand written-out tests remain the right tool where the table shape
    doesn't fit: fringe cases whose setup deviates from the table's shared
    arrange step, multi-step scenarios, or single-case testing of a method
    with little functionality.
  - Base fixtures are visible const literals (e.g. `VALID_PARAMS`), never factory
    functions with hidden defaults. A case's variation is an explicit spread of
    the base with the delta inline in the row.
  - Never wrap the function under test in a helper that defaults away its
    arguments; call it directly with every argument visible at the call site.
  - Setup harnesses are acceptable magic: hide the *arrange* step, never the
    *act* or *assert*.
  - Prefer slightly verbose but self-contained over terse but indirect —
    verbosity costs lines; indirection costs comprehension.
- **ALWAYS type.** Every function parameter, return value, variable, and prop must
  have a precise type. Never use `unknown` (and never `any`) as a substitute for
  finding the real type — dig for it in the SDK's type definitions
  (`node_modules/<pkg>/**/*.d.ts`) or the workspace's own packages, and use or
  re-export that.
- **Keep domain values in their richest type; serialize ONLY at the edges.** A
  transaction stays an ethers `Transaction`, an id stays its branded type, an
  amount stays `bigint` — pass the typed object between internal functions, and
  collapse it to a string only where it truly leaves the program: stdout/logging,
  a CLI arg parser, an RPC/`fetch` body, an on-ledger write. Re-parsing a value
  you already had typed discards a precise type, invites drift, and can fail on
  data your own code just produced. A producer returns the typed object; the
  single caller that hits the edge does the conversion.
- **ALWAYS write JSDoc on everything exported.** Every exported function,
  const, type, interface, and interface method carries a JSDoc block stating its
  purpose, one `@param <name> - <purpose>` per parameter, `@returns` when it
  returns a value, and `@throws` when it throws. Types live in the TypeScript
  signature ONLY — never repeat them in `{braces}` in the JSDoc, they drift.
  Document non-obvious contracts (mutation, consumption, ordering invariants) in
  the description, and cross-reference related exports with `{@link Name}`.
- **ALWAYS use an `enum` for a fixed set of named constants.** Status/state
  machines, kinds, modes, variants — model them as a named TypeScript `enum`, never
  a bare union of string literals or repeated inline literals. Reference members
  (`Status.Ready`), never the literal.
- **NEVER duplicate an enum (or const-enum-like object) an SDK already exports.**
  Import and use the SDK's own. Only define an app-local enum when the SDK
  genuinely has none — check its `.d.ts` first.
- **NEVER write a TS function that mimics the behavior of a pure circuit the SDK
  exports.** Call the SDK's compiled artifact (`pureCircuits.<name>`). TS may only
  implement what circuits cannot: secret-key signing, witness computations, and
  byte plumbing. A TS twin of provable logic WILL drift from the circuit and
  break agreement with the proofs silently.
- **Declare types and helpers immediately above their single consumer; the top
  of a file is reserved for what the WHOLE file needs.** A
  struct/type/interface/constant/helper used by exactly ONE function sits directly
  above that function. The top of a file holds only file-wide declarations. The
  moment a declaration gains a second consumer, move it to the top (or out to its
  shared home) in the same change. This applies to every language in the repo:
  TypeScript, Compact contracts, test files, all of it.
- **Root scripts that target one example are named `<task>:<example-dir>` — the
  example's directory name in full, never a shorthand.** `test:erc20-vault`,
  `compile:erc20-vault` — never `test:vault`: abbreviations save keystrokes once
  and cost a which-example-was-that lookup forever. Aggregate scripts (`compile` /
  `build` / `test`) take no suffix. When adding or renaming a root script, grep
  the WHOLE repo for the old name before finishing — CI workflows and READMEs
  quote script names.

# Contract packages (`examples/*/contract`)

Every example's contract package is deliberately identical in shape; these rules
apply to all of them:

- **The export surface is environment-agnostic — it runs unchanged in a browser
  or a backend.** Contract packages are consumed as SDKs by downstream
  applications (including browser apps combining many chains), so nothing
  reachable from `src/index.ts` may use environment-specific APIs or types: no
  `node:` builtin imports (fs, path, crypto, …), no `process`/`process.env`
  access, no `Buffer` (use `Uint8Array`), no DOM/browser globals, no Node-only
  dependencies. Configuration enters as typed function parameters — never read
  from the environment. This is the rule that decides what may live here: the
  ledger reads, the provider TYPE and the circuit-id union qualify, while the
  Node binding and a live provider set do not and live in the example's
  `client` package. Env access, filesystem and `@sig-net/midnight-examples-lib` imports
  belong in `client`, `deploy` or `integration-tests`, never in a contract
  package.
- **Every in-circuit hash is `transientHash`** (wrapped in
  `upgradeFromTransient` where a `Bytes<32>` digest is needed), whatever the
  persistence class of the hashed value. No circuit calls `persistentHash` or
  `keccak256`: Poseidon costs ~90 constraint rows where SHA-256 costs ~3,800
  and keccak ~4,600 per 136-byte block. `transientHash` is pinned by the
  chain's ledger era and can change at a proof-system hard fork; that exposure
  is accepted repo-wide and handled operationally, so each derivation site
  documents its own consequence (drain pending requests before such a fork;
  persisted digests need coordinated migration). `keccak256` stays correct in
  off-chain code where a foreign spec fixes it (EVM ABI selectors and storage
  slots, EIP-1559 transaction hashing, epsilon derivation).
- **Compile before you check.** `yarn compile` regenerates `src/managed/`;
  typecheck and tests read its emitted `contract/index.d.ts`.
- **`src/index.ts` is the curated export surface** — it re-exports the managed
  output plus the handwritten witnesses. Consumers import the package root; NEVER
  deep-import `src/managed/...` paths from outside the package (the `./managed/*`
  export exists only so runtimes can fetch `zkir/`/`keys/` as assets).
- **Witnesses live beside the contract they serve**, in `src/witnesses.ts`, typed
  against the generated `Witnesses<PS>` type.
- **Simulator test pattern** (see any example's `tests/`):
  `new Contract(witnesses)` → `await contract.initialState(createConstructorContext(ps, CPK))`
  → `createCircuitContext(circuitId, sampleContractAddress(), CPK, state, ps)` → await
  circuits (they are async), threading `result.context` forward → decode with
  `ledger(ctx.callContext.currentQueryContext.state)`. Circuit failures reject the
  promise (`await expect(...).rejects.toThrow(...)`). Pure circuits are synchronous,
  called directly via `pureCircuits.<name>(...)`.
- **The deploy split: generic plumbing in `packages/lib`, everything
  contract-specific in the example's own `deploy` package.** lib's deploy/wallet
  helpers know no contract; the example's deploy package owns the constructor
  args, witnesses, private state and post-deploy circuit calls, statically
  importing its own contract package's generated module so all of it stays fully
  typed. There is NO generic deployer package: a generic deployer forces dynamic
  module loading and witness stubs, which break the moment a constructor takes
  real args — keep deploy logic static and fully typed in the example's own
  packages.
- **Every deploy flow is a typed function taking an `env` map, and the
  entrypoint is a shell over it.** `deployX(env = process.env)` returns its
  outcome (the contract address, an initialise outcome enum); the CLI entrypoint
  and the e2e setup step both CALL it, so the multistage deploy a remote network
  needs is exercised on every local run. Never spawn a deploy as a subprocess and
  parse its stdout: config then differs per caller, the return value degrades to
  a regex, and only one of the two paths gets tested. Config is read from the
  passed map (never `process.env` directly, never mutated), so every process
  reads the SAME variable for the same thing.
