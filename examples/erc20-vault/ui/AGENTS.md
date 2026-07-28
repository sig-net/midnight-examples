# erc20-vault UI — agent rules

The browser SPA over the erc20-vault example. The workspace-wide rules in the
repository root's [AGENTS.md](../../../AGENTS.md) all apply here; this file adds
what is specific to this member, and wins where the two ever disagree.

This is the only member type that bundles, so it is the only one that can drift
into an app framework. These rules keep it an example.

## Shape

```
index.html          # the HTML entry, and the pre-paint theme script
vite.config.ts      # bundler plugins, the "@/" alias, the vitest (jsdom) block
components.json     # shadcn/ui's config: base, style and the "@/" aliases
public/             # served verbatim at the site root
  sig-network.png   # the Signature Network mark, in the header
src/
  main.tsx          # mounts <App/> into #root
  App.tsx           # the provider stack wrapped around the route table
  routes.ts         # RoutePath enum: the single source of truth for paths
  index.css         # Tailwind import and shadcn/ui's design tokens
  vite-env.d.ts     # every VITE_ variable the app reads, precisely typed
  components/       # presentational components: precise props, no fetching
    AppLayout.tsx   # the shell: header controls, outlet, footer
    WalletMenu.tsx  # one chain's wallet control in the header
    WalletMark.tsx  # a wallet's own icon, rendered safely
    StepCard.tsx    # one step of the flow, and the not-built-yet body
    ConnectWalletsStep.tsx  # step one's rows, one per chain
    ThemeToggle.tsx # light / dark / system
    contexts/       # app-wide React contexts, all mounted in App.tsx
    ui/             # shadcn/ui components, copied in by its CLI
  hooks/            # the logic the components render
    useWalletConnections.ts  # both chains, normalised to one shape
  lib/              # non-React modules the components lean on
    utils.ts        # cn(): the class merger every ui/ component imports
    theme.ts        # the theme choice, its storage, and how it is applied
    errorMessage.ts # describeError(): a rejection, made fit to render
  pages/            # one component per route
tests/
  setup.ts          # jest-dom matchers, the matchMedia stub, per-test cleanup
  fakeWallets.ts    # both chains, faked at the extension boundary
  App.test.tsx      # route table coverage as a typed case table
  AppChrome.test.tsx # the header controls, driven by accessible name
  HomeSteps.test.tsx # the step sequence and the connect step's three states
```

## Rules

- **The stack is Vite + React + React Router, and stays there.** Vite bundles,
  React renders, React Router routes in declarative mode: no Vite router plugin,
  no SSR, no file-system routing. Styling is Tailwind, configured in CSS via
  `@theme` in `src/index.css` (Tailwind v4 has no `tailwind.config.js`, and
  adding one is a regression). Reach for a global client-state library only when
  component state has genuinely run out, and say in the commit why.
- **Components come from shadcn/ui, and they land in the repository.**
  `yarn dlx shadcn@latest add <component>` copies the source into
  `src/components/ui/`, where it becomes ordinary owned code: edit it in place,
  and never re-derive it at runtime. `components.json` pins the base (`radix`)
  and style (`nova`) the CLI generates against, so a component added months from
  now still matches the ones already here. Its imports resolve through the `@/`
  alias, which is declared TWICE and must stay in step: `paths` in
  `tsconfig.json` for the typecheck, `resolve.alias` in `vite.config.ts` for the
  bundle. Write an unstyled element by hand only where the registry has nothing
  that fits.
- **shadcn/ui's colour vocabulary is the only one.** `bg-background`,
  `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`,
  `text-primary`, with the values living in the `:root` and `.dark` blocks of
  `src/index.css`. Restyle by editing those values, never by adding a second
  token set beside them: two names for one colour is how a component ends up
  matching neither.
- **The theme is decided in exactly two places, and a component is neither.**
  `src/lib/theme.ts` owns the choice, its storage key and how it reaches the
  DOM. `ThemeContext` owns it from mount onwards and is what a component reads,
  through `useTheme`. The inline script in `index.html` is the only exception,
  and only for the first paint: it cannot import the module (a module script
  runs after first paint and would flash the wrong theme), so it duplicates the
  storage key and the light/dark decision in a few lines, with a comment on
  each side pointing at the other. Keep the two in step. Never read
  `prefers-color-scheme` from a component, and never add a second theme store:
  the sonner wrapper is edited away from its registry version precisely to stop
  `next-themes` becoming one.
- **The overview is the flow, as steps, and each step owns its own state.**
  `HomePage` is an ordered list of `StepCard`s and nothing else: no title, no
  blurb, no endpoint tables. A step reports where it is in its own accessible
  name (`"Step 1: Connect wallets (complete)"`), goes green on its ring rather
  than a border (shadcn's `Card` draws its edge with `ring`, so a `border-*`
  class there is invisible), and a step that is not built yet says so in its
  body via `ComingSoon` rather than in a badge, which a card this narrow
  clips. A control that has done its job stops being a control: a connected
  wallet row becomes a statement, since a button that would do nothing invites
  a click that does nothing.
- **A chain-shaped difference is normalised in a hook, never in a component.**
  `useWalletConnections` publishes both chains as one `WalletConnection` shape,
  and the header control and the connect step both just render it. Neither
  knows that the Midnight list is read on demand while wagmi's arrives by
  announcement. Reach for the raw contexts only when you need something the
  normalised shape genuinely cannot carry, and widen the shape first if it can.
- **Never build a user-facing sentence by concatenating an article.**
  "Connect a Midnight wallet" and "Connect an EVM wallet" disagree, and picking
  the article from a chain name is a trick the next chain breaks. Word the
  label so it does not need one.
- **A control that reflects a connection lives in the shell, not on a page.**
  A wallet outlives navigation, so a control that unmounted on a route change
  would suggest the connection had too. It also must say which chain it speaks
  for: two wallet glyphs side by side are indistinguishable, which is why the
  chain name is on the control itself and drops only below `sm`, where the
  accessible name still carries it. State goes in the accessible name too
  (`"Midnight wallet: connected"`), so a screen reader gets what the coloured
  dot conveys to everyone else and the tests have something honest to query.
- **A wallet's name and icon are the EXTENSION's strings, not yours.** Render
  the name as a text node and the icon as an `img` source, never as markup: the
  connector APIs document the XSS risk in as many words. A failed connect goes
  to a `sonner` toast carrying the connector's own message, never to a
  swallowed promise and never to `alert`.
- **NEVER install a dependency ahead of its first consumer.** A package with
  nothing importing it is scaffold leftover, and the workspace's no-dead-code
  rule applies to manifests as much as to source. Add it in the same change as
  the feature that needs it.

  shadcn/ui is the single exception, and it is deliberate. `shadcn init` and
  `shadcn add` install what their registry generates against (`radix-ui`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`,
  `tw-animate-css`, `shadcn` itself for `shadcn/tailwind.css`), and a component
  under `src/components/ui/` may sit unimported until the feature that renders
  it arrives. Leave both alone.

  Pruning them is not a tidy-up, and the failure is delayed rather than loud.
  Most registry items declare NO dependencies of their own while still
  importing from `lucide-react`, so the CLI installs nothing and trusts what
  init left behind. Removing `lucide-react` today costs nothing until someone
  runs `shadcn add checkbox` months from now: the component is written, the CLI
  reports success, and the build then fails on `TS2307: Cannot find module
  'lucide-react'` in a file that person did not write. Verified by doing
  exactly that, on 2026-07-28.

  What makes those dangerous is that they are UNDECLARED. A dependency a
  registry item does declare is a different case: the CLI reinstalls it on the
  next `add`, so it can be removed once nothing imports it. That is why
  `next-themes` is gone. It arrived declared by `sonner`, and the sonner
  wrapper now reads this app's own ThemeContext instead, which leaves it with
  no importer and a CLI that would bring it back if it were ever needed again.

  The exception covers ONLY what the shadcn CLI itself writes. A package you
  install by hand, including one you noticed because a shadcn component
  happened to use it, is governed by the rule above.
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
