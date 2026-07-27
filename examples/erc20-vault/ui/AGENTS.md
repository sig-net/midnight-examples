# erc20-vault UI — agent rules

The browser SPA over the erc20-vault example. The workspace-wide rules in the
repository root's [AGENTS.md](../../../AGENTS.md) all apply here; this file adds
what is specific to this member, and wins where the two ever disagree.

This is the only member type that bundles, so it is the only one that can drift
into an app framework. These rules keep it an example.

## Shape

```
index.html          # the single HTML entry Vite serves and bundles
vite.config.ts      # bundler plugins plus the vitest (jsdom) block
src/
  main.tsx          # mounts <App/> into #root
  App.tsx           # the provider stack wrapped around the route table
  routes.ts         # RoutePath enum: the single source of truth for paths
  index.css         # Tailwind import and the design tokens
  vite-env.d.ts     # every VITE_ variable the app reads, precisely typed
  components/       # presentational components: precise props, no fetching
    contexts/       # app-wide React contexts, all mounted in App.tsx
  pages/            # one component per route
tests/
  setup.ts          # jest-dom matchers and per-test cleanup
  App.test.tsx      # route table coverage as a typed case table
```

## Rules

- **The stack is Vite + React + React Router, and stays there.** Vite bundles,
  React renders, React Router routes in declarative mode: no Vite router plugin,
  no SSR, no file-system routing. Styling is Tailwind, configured in CSS via
  `@theme` in `src/index.css` (Tailwind v4 has no `tailwind.config.js`, and
  adding one is a regression). Reach for a global client-state library only when
  component state has genuinely run out, and say in the commit why.
- **NEVER install a dependency ahead of its first consumer.** A package with
  nothing importing it is scaffold leftover, and the workspace's no-dead-code
  rule applies to manifests as much as to source. Add it in the same change as
  the feature that needs it.
- **`build` is `tsc -p tsconfig.json && vite build`, in that order.** The
  typecheck still governs; the emitted `dist/` is a gitignored deploy artefact.
  NOTHING may import from it: this package has no `exports` field and is never a
  dependency of another member. Code another member needs moves to the example's
  `contract` package (or the SDK) rather than being imported out of a bundle.
- **Chain access goes through `@midnight-examples/erc20-vault-contract`.** Its
  `src/index.ts` is environment-agnostic precisely so a browser can import it.
  Never reimplement circuit calls, address derivation or encoding that the
  contract package or `@sig-net/midnight` already exports.
- **Of the shared packages, ONLY `@midnight-examples/chain-config` may be
  imported.** It is isomorphic by contract: data, types and pure functions with
  no runtime dependency, so it bundles here and still runs under Node for the
  flows and the harness. Anything you add to it must keep BOTH halves working,
  which is why it has its own AGENTS.md. `@midnight-examples/lib` and
  `@midnight-examples/test-harness`
  are Node-only and NEVER appear here: lib's barrel re-exports a deploy module
  that pulls in `@effect/platform-node` and undici, which a bundler stubs rather
  than rejects, so the failure surfaces as a runtime error in the browser and
  not as a red build. Before adding any dependency that might not be
  browser-safe, bundle it on its own with `vite build` and check the output for
  "externalized for browser compatibility" warnings.
- **NEVER read configuration from a hardcoded constant.** Contract addresses,
  indexer and proof-server URLs and network ids enter through `import.meta.env`
  (`VITE_`-prefixed) over the defaults `@midnight-examples/chain-config`
  publishes, and are validated at startup so a bad value fails loudly rather
  than rendering an empty view. EVERY variable the app reads is declared in
  `src/vite-env.d.ts`: Vite types `import.meta.env` with an `any` index
  signature, so an undeclared variable is a silent `undefined` at runtime rather
  than a typo the compiler catches.
- **NEVER fetch in a `useEffect`.** The first feature that reads chain or
  indexer state brings TanStack Query in with it, and every read after that is a
  `useQuery` and every write a `useMutation`. A hand-rolled fetch-and-set-state
  has no cache, no retry and no in-flight state, and it teaches an integrator the
  wrong pattern.
- **Components take precise props and render; logic lives in hooks.** A
  component file holds the component and the types it alone consumes. The moment
  a second component needs one, it moves into a hook or shared module in the same
  change, per the root's declare-above-the-single-consumer rule.
- **A new route lands as three edits in one change:** a new `RoutePath` member, a
  page component under `src/pages/`, and a row in the `App.test.tsx` case table.
  A route absent from any of the three is a defect.
- **Tests render the app, not the internals.** vitest with the `jsdom`
  environment plus Testing Library, querying by role and accessible name, never
  by test id or class. Route coverage is one typed case table over `it.each`,
  matching the root's table-driven rule.

## Verifying a change

`yarn build && yarn test` in this package, per the root's finish-a-change rule.
Both must be green, and neither is optional: `vite dev` executes without
typechecking, so "it renders" is not verification.

When a change is visual or navigational, also drive the running app rather than
trusting the DOM assertions alone: `yarn dev`, then load `http://localhost:5173`,
check the route renders and the browser console is clean.
