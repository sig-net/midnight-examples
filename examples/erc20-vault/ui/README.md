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
| Components | shadcn/ui, on the Radix base in the `nova` style |
| Tests | vitest 4 + Testing Library, in a `jsdom` environment |

Components are not a dependency: `yarn dlx shadcn@latest add <component>` copies
the source into `src/components/ui/`, and from there it is ordinary code in this
repository, to read and to edit. `components.json` records the base and style so
a component added later matches the ones already here.

Colours come from shadcn's tokens: `bg-background`, `text-muted-foreground`,
`border-border` and the rest, with the values in the `:root` and `.dark` blocks
of `src/index.css`. Restyle the app by editing those values. Dark mode follows
the operating system, applied as a `dark` class on `<html>` by a short script in
`index.html` so the first paint is already the right theme.

This is the only package in the workspace that bundles: a browser has no way to
load TypeScript. `yarn build` emits a gitignored `dist/`, which is a deploy
artefact and not something other packages import.

## Layout

```
index.html          # the single HTML entry Vite serves and bundles
vite.config.ts      # bundler plugins, the "@/" alias, the vitest (jsdom) block
components.json     # shadcn/ui's config: base, style and the "@/" aliases
src/
  main.tsx          # mounts <App/> into #root
  App.tsx           # the provider stack wrapped around the route table
  routes.ts         # RoutePath enum: the single source of truth for paths
  index.css         # Tailwind import and shadcn/ui's design tokens
  vite-env.d.ts     # every VITE_ variable the app reads, precisely typed
  components/       # the application shell
    contexts/       # app-wide React contexts
    ui/             # shadcn/ui components, copied in by its CLI
  lib/              # non-React modules the components lean on
  pages/            # one component per route
tests/              # Testing Library specs run under vitest
```

## Configuration

The app starts on the local standalone stack (`undeployed`) with the endpoint
defaults published by `@midnight-examples/chain-config`. Put any override in a
`.env.local` file in this directory. Only `VITE_`-prefixed variables reach the
browser.

| Variable | Effect |
| --- | --- |
| `VITE_MIDNIGHT_NETWORK_ID` | Which network to start on. Startup fails naming the valid ids if this is not one of them. |
| `VITE_MIDNIGHT_INDEXER_URL` | Indexer GraphQL over HTTP. Setting it also derives the WebSocket URL, so the two cannot point at different hosts. |
| `VITE_MIDNIGHT_INDEXER_WS_URL` | Indexer GraphQL over WebSocket, when it is not simply the twin of the HTTP URL. |
| `VITE_MIDNIGHT_NODE_URL` | Midnight node RPC. |
| `VITE_MIDNIGHT_PROOF_SERVER_URL` | Proof server. Stays local by default: it sees private witness data. |
| `VITE_EVM_RPC_URL` | JSON-RPC endpoint of the EVM chain. Defaults to the local anvil compose service. |
| `VITE_EVM_CHAIN_ID` | The EVM chain id to expect. Defaults to anvil's 31337. |
| `VITE_EVM_EXPLORER_URL` | Block explorer base URL, for linking transactions and addresses. |

These set the *starting* config. Switching Midnight network in the running app
resets every endpoint to that network's published defaults, so stagenet (whose
endpoints this repo deliberately does not publish) has to be selected through
the environment.

The EVM chain id is not cosmetic: the vault seals `eip155:<chainId>` into its
contract at initialize, and that is the routing key the MPC signs against.
Nothing here yet proves the RPC actually serves the chain id you configured,
so a mismatch is currently undetected. Verifying it needs a live `eth_chainId`
call, which arrives with the first feature that talks to the chain.

## Where the chain wiring goes

The shell is deliberately free of chain code, so the first real feature has a
clean seam to land against:

1. Add the wallet connection and expose the connected address through a hook.
2. Add a query over the deployed contract's state, keyed by its address.
3. Add deposit and withdrawal mutations that refresh that state on success.

All of it reaches the chain through `@midnight-examples/erc20-vault-contract`,
whose export surface is environment-agnostic so a browser can import it directly.
