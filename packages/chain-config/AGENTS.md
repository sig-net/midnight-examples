# `@midnight-examples/chain-config` — agent rules

Chain configuration primitives: network ids, endpoint defaults and the
`MidnightNodeConfig` shape. The workspace-wide rules in the repository root's
[AGENTS.md](../../AGENTS.md) all apply here; this file adds what is specific to
this package, and wins where the two ever disagree.

# THE CRITICAL RULE

**This package MUST run unchanged in BOTH a browser bundle and Node. Every
other rule here exists to protect that.**

It is the ONLY shared package a `ui` member may import, and it is imported by
`packages/lib` and the example flows, which are Node. Both halves of that are
load-bearing. Breaking either half is silent:

- **Break the browser half** (a `node:` import, `process`, `Buffer`, a runtime
  dependency that reaches for any of them) and a bundler does NOT fail. Vite
  externalises the builtin and emits a stub, so the first symptom is a runtime
  error in a deployed UI that no CI run ever saw.
- **Break the Node half** (`document`, `window`, `localStorage`, or any other
  DOM global) and the typecheck does NOT fail either, since `lib.dom` is in
  this package's tsconfig for the `URL` type. The first symptom is a
  `ReferenceError` deep inside an e2e run.

Neither failure mode is caught by a green build. The rules below are the
enforcement.

## Rules

- **NEVER add a runtime dependency.** The manifest's `dependencies` block stays
  empty and MUST stay empty. Type-only `devDependencies` are fine, as they erase
  under `verbatimModuleSyntax` and reach neither runtime. A runtime dependency
  is the single most likely way this package's guarantee dies, and the manifest
  diff is what review has to catch it.
- **NEVER use a Node builtin or Node global IN `src/`.** No `node:` import, no
  `process`, no `Buffer` (use `Uint8Array`), no `__dirname`, no filesystem, no
  networking. The tests are exempt and Node-only by design: they read `src/` off
  disk to enforce these very rules.
- **NEVER use a DOM global.** No `document`, no `window`, no `localStorage`, no
  `fetch`. `lib.dom` is in the tsconfig for the WHATWG `URL` type ALONE, which
  Node and browsers both implement. It is not permission to use the rest of it:
  the compiler will happily accept `document.querySelector` here, and Node will
  then throw at runtime.
- **NEVER read an environment.** Not `process.env`, not `import.meta.env`.
  This package holds data, types and pure functions. Obtaining values FROM an
  environment belongs to the consumer, since how that works differs per
  environment: `getMidnightNodeConfig` in `@midnight-examples/lib` reads
  `process.env`, and an example's `ui` member reads `import.meta.env`.
- **Only universal language and web-standard APIs.** `URL`, `JSON`, `Math`,
  `Intl`, `TextEncoder`, `structuredClone` and the like are available in both
  runtimes and are fine. If you are unsure whether an API is, it does not go
  here.
- **A pure transform over config values belongs here, not in a consumer.**
  `indexerWsUrlFromIndexerUrl` is the pattern: the Node reader and the browser
  app both need it, and a second implementation would drift. A helper used by
  exactly one consumer stays with that consumer.
- **One directory per chain under `src/`, and the exports stay flat.** Since a
  call site sees a bare name, anything that would be ambiguous across chains
  says which chain it is: `LOCAL_EVM_CHAIN`, `evmCaip2ChainId`. The Midnight
  names are the ONE exception and stay unprefixed, matching
  `@sig-net/midnight-contract-deploy`'s `plumbing/` exports verbatim so that
  deleting this package stays a change of import path rather than a rename.
- **NEVER add Midnight's CAIP-2 id here.** `@sig-net/midnight` already exports
  it as `MIDNIGHT_TESTNET_CHAIN_ID` (`"midnight:testnet"`). It is a fixed
  protocol constant, NOT a function of the network id: the MPC hashes it
  verbatim inside `keccak256("<prefix>:<chainId>:<requester>:<path>")`, so a
  per-network variant would be an identifier the MPC has never seen and would
  silently derive different keys. `evmCaip2ChainId` exists only because the
  `eip155` reference genuinely varies per chain.

## How the guarantee is enforced

`yarn build && yarn test` in this package checks both halves. Three mechanisms,
and you need to know what each does and does not catch:

1. **`tsconfig.json` compiles `src/` with no Node types** (`types: []` from the
   base config). `process`, `Buffer` and every `node:` import are therefore
   compile errors in `src/`. This is why the tests compile under a SEPARATE
   `tsconfig.tests.json`: they are Node and read the filesystem. NEVER merge
   the two to satisfy a test, and NEVER add `types: ["node"]` to
   `tsconfig.json` — either move silently deletes this check.
2. **`tests/isomorphic.test.ts` scans `src/` for forbidden globals**, in both
   directions, and asserts the manifest declares no runtime dependency. It
   covers what the compiler cannot: `lib.dom` is in the tsconfig for the `URL`
   type, so `document.title` in `src/` type-checks happily and would throw only
   under Node.
3. **Nothing standing checks the bundle itself.** Adding an import that reaches
   a Node builtin transitively would pass 1 and 2. If you ever add one, bundle
   this package alone from an example's `ui` directory with `vite build` and
   confirm the output contains zero "externalized for browser compatibility"
   warnings.

The scan is a real check, not decoration: adding `process.env` and
`document.title` to a source file fails it on both counts.
