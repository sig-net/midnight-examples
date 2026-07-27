# erc20-vault UI

The browser front end for the erc20-vault example: a single-page app that will
let a user connect a Midnight wallet, read the deployed vault's state, and drive
its deposit and withdrawal circuits.

Today it is the shell. Routing, styling and the test setup are in place and
green, and the chain wiring is what goes in next.

## Running it

From the repository root (never run `yarn install` from inside this directory):

```sh
yarn install
yarn dev:erc20-vault-ui  # http://localhost:5173, hot reload
yarn build:erc20-vault   # typechecks every vault package, then bundles this one
```

Within this package the scripts are `dev`, `build`, `preview` and `test`.
`build` runs `tsc` before `vite build`, so a type error fails the bundle rather
than shipping.

## The stack

| Piece | Choice |
| --- | --- |
| Bundler | Vite 8 |
| UI | React 19 |
| Routing | React Router 8, declarative mode |
| Styling | Tailwind 4, configured in CSS via `@theme` in `src/index.css` |
| Tests | vitest 4 + Testing Library, in a `jsdom` environment |

This is the only package in the workspace that bundles: a browser has no way to
load TypeScript. `yarn build` emits a gitignored `dist/`, which is a deploy
artefact and not something other packages import.

## Layout

```
index.html          # the single HTML entry Vite serves and bundles
vite.config.ts      # bundler plugins plus the vitest (jsdom) block
src/
  main.tsx          # mounts <App/> into #root
  App.tsx           # the route table, every route inside the shared shell
  routes.ts         # RoutePath enum: the single source of truth for paths
  index.css         # Tailwind import and the design tokens
  components/       # the application shell
  pages/            # one component per route
tests/              # Testing Library specs run under vitest
```

## Where the chain wiring goes

The shell is deliberately free of chain code, so the first real feature has a
clean seam to land against:

1. Add the wallet connection and expose the connected address through a hook.
2. Add a query over the deployed contract's state, keyed by its address.
3. Add deposit and withdrawal mutations that refresh that state on success.

All of it reaches the chain through `@midnight-examples/erc20-vault-contract`,
whose export surface is environment-agnostic so a browser can import it directly.
