# midnight-examples — workspace-wide agent rules

This repository is a single **Yarn workspace** (Yarn 4 via corepack, `nodeLinker:
node-modules`), split between shared machinery and the examples integrators copy:

- **`packages/lib`** — runtime helpers imported by examples (wallet,
  providers, tx build & submit). Kept ruthlessly small.
- **`packages/test-harness`** — test-only machinery (stack bring-up/teardown,
  mpc-keys setup, wallet funding, env/session handling, subprocess helpers).
  Test-only deps live here and never touch an example's manifests.
- **`examples/*/*`** — one directory per example, each holding 1–2 workspace
  packages: `contract` (required) and `integration-tests` (as warranted). An
  example's flows are typed functions in `integration-tests/src/flows/`, run
  in-process by its tests; `integration-tests/scripts/` holds thin `tsx`
  entrypoints over those same flows for hand-driving a live stack.

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
- **No workspace package is published by default.** Every member uses the
  `@midnight-examples/*` scope and starts `"private": true`. The one exception
  is contract packages: each is written to be publishable as-is (see the
  environment-agnostic rule under "Contract packages"), and individual ones may
  be published for consumption by downstream example applications that combine
  many chains. Anything else worth publishing graduates to the protocol repo's
  SDK packages.

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
- **ALWAYS install dependencies at the latest STABLE version; NEVER pin.** First
  resolve the version — `yarn npm info <pkg> --fields dist-tags,version,deprecated`
  — then add it explicitly: `yarn workspace <workspace> add <pkg>@^<version>`, where
  `<version>` is that latest stable release. The caret is deliberate and NOT
  optional: `yarn add` writes exactly the range you name, so a bare
  `<pkg>@<version>` would silently pin — always spell the `^`. If the resolved
  latest is a prerelease (`-rc`/`-beta`/`-alpha`/`-next`/`-canary`), STOP and ask
  the user — never adopt a prerelease unprompted. Before you install, confirm the
  release is not deprecated and `yarn npm audit` reports no new advisory. The
  compact toolchain is likewise unpinned: `compact update` installs it and compile
  scripts carry **no `+version` pin**. Corollary: a dependency shared by two
  members MUST resolve to the same version in every member — bump it everywhere in
  the same change and `yarn install` from the root. A single shared version is what
  keeps the WASM-backed `@midnight-ntwrk/*` packages resolving to one instance;
  divergence causes dual-instance "expected instance of…" bugs.
- **NEVER emit JavaScript.** Packages export TypeScript source
  (`"." : "./src/index.ts"`); `build` means `tsc` under the base config's `noEmit`.
  No `dist/`, no `tsc --outDir`, no ts-node loaders, no copy steps. Tests run under
  vitest; entrypoints run under `tsx`. If you think you need a build step, stop and
  ask — a build step is a defect in this workspace, not a missing feature.
- **ALWAYS finish a change with `yarn build && yarn test`** in the member you
  touched (or from the root). `tsx` and vitest execute without typechecking — "it
  runs" is NOT verification. If you add a new top-level TS directory to a member,
  add it to that member's tsconfig `include` in the same change; a file outside
  `include` passes silently and then breaks in the IDE.
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
  from the environment. `deploy.ts` sits outside the export surface precisely so
  it can be a Node entrypoint: env access, filesystem, and
  `@midnight-examples/lib` imports belong there (or in `integration-tests`),
  never under `src/`.
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
  contract-specific in the example's own `deploy.ts`.** lib's deploy/wallet
  helpers know no contract; the deploy script owns the constructor args,
  witnesses, private state and post-deploy circuit calls, statically importing its
  own generated module so all of it stays fully typed. There is NO generic
  deployer package: a generic deployer forces dynamic module loading and witness
  stubs, which break the moment a constructor takes real args — keep deploy logic
  static and fully typed in the example's own contract package.
