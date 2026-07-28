# erc20-vault UI

The browser front end for the erc20-vault example: a single-page app that will
let a user connect a Midnight wallet, read the deployed vault's state, and drive
its deposit and withdrawal circuits.

The overview presents that as three steps, worked through left to right:
connect the wallets, derive the deposit address, then interact with the vault.
The third step reads today and will write later: it shows what every account in
the flow holds, and its card says that depositing and withdrawing are still to
come. The cards are compact, equal-height summaries over one view area below them:
selecting a card (its title is the control) puts that step's full details in
the view area, and the selection follows the user's progress until a card is
chosen by hand.

Step two establishes the caller's vault identity. The Midnight wallet is asked
to sign a fixed message (`signet-wallet-erc20-vault-demo`), the secret key is
the SHA-256 hash of that signature, and only its commitment (the compiled
`userCommitment` circuit) ever reaches the ledger. From the commitment the app
derives the caller's EVM deposit address: the account only the MPC network can
sign for, whose derivation combines the MPC root public key, the vault
contract's address, and the commitment as the derivation path. The secret is
stored in the browser (encrypted, scoped per wallet account), and a key found
there with a derived address is already enough to proceed to the vault
interactions. A found key can also be regenerated (re-signed and overwritten),
but only behind a tick box acknowledging the loss: unless the wallet signs
deterministically, the new signature derives a different key, and unclaimed
deposits or pending refunds tied to the old commitment go with it.

Step three is where the value shows up. A deposit moves ERC20 value from your
own derived account into the vault's and mints a shielded token against it, and
a withdrawal runs the same path backwards, so four accounts across two chains
decide whether any of it worked:

| Account | Where it comes from |
| --- | --- |
| EVM browser wallet | The connected wallet: what funds a deposit's gas and its tokens |
| Your deposit address | Derived in step two: the account the MPC signs a deposit's transfer from |
| Vault address | The vault's own EVM account, read from its ledger (the contract pins it at initialize) |
| Midnight browser wallet | The connected wallet's shielded and unshielded balances, plus its dust |

The vault handles any ERC20 and its ledger names none of them, so there is no
token list to offer: paste the addresses you care about and each EVM panel adds
a row per token. A token that answers no `name()` or `symbol()` reads as
Unknown, and one that answers no `decimals()` leaves its balance in atomic
units rather than guessing a scale. Midnight amounts stay in atomic units
throughout: a token type there is an opaque id with no metadata behind it.

Depositing and withdrawing are not built yet, which is what the third card's
"Coming soon" says.

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
of `src/index.css`. Restyle the app by editing those values.

## The header

The header carries the whole control surface, since a connection outlives
navigation:

| Control | What it shows |
| --- | --- |
| Midnight wallet | Grey dot and a washed-out icon until connected, then the wallet's own icon and a green dot |
| EVM wallet | The same, over wagmi's EIP-6963 discovery |
| Theme | Light, dark, or system |

Opening a wallet control lists the wallet extensions the browser announced, and
connecting is one click from there. With a wallet connected the same menu shows
which one, its address on the EVM side, and a disconnect. A connection that
fails raises a toast carrying the wallet's own words rather than failing
silently, so a declined prompt reads as a declined prompt.

The first step card offers the same connections, one row per chain, and is the
place to start rather than the header. It counts how many of the two are in,
ticks each row as it connects, and turns green once both are. The page heading
tracks it: "To start you'll need 2 connected wallets" until both are connected,
"Wallet connections set" afterwards. Disconnecting stays in the header, so it
never competes with the step's forward motion.

Theme choice is one of light, dark or system, persisted under
`erc20-vault-ui.theme`. System is the default and follows the operating system
live. A short script in `index.html` applies the choice before the first paint,
which is what stops a reload flashing the wrong theme.

This is the only package in the workspace that bundles: a browser has no way to
load TypeScript. `yarn build` emits a gitignored `dist/`, which is a deploy
artefact and not something other packages import.

## Layout

```
index.html          # the HTML entry, and the pre-paint theme script
vite.config.ts      # bundler plugins, the "@/" alias, the vitest (jsdom) block
components.json     # shadcn/ui's config: base, style and the "@/" aliases
public/             # served verbatim at the site root, including the SIG mark
src/
  main.tsx          # mounts <App/> into #root
  App.tsx           # the provider stack wrapped around the route table
  routes.ts         # RoutePath enum: the single source of truth for paths
  index.css         # Tailwind import and shadcn/ui's design tokens
  vite-env.d.ts     # every VITE_ variable the app reads, precisely typed
  components/       # the shell, the header controls and the step cards
    contexts/       # app-wide React contexts, including the theme
    ui/             # shadcn/ui components, copied in by its CLI
  hooks/            # the logic the components render
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
| `VITE_MPC_SECP256K1_PUBKEY` | The MPC network's root secp256k1 public key (hex, compressed or uncompressed, `0x` optional). Deposit addresses derive from it; unset, everything else works and the app says the address cannot be derived. The local fakenet's key is generated per machine, printed as `MPC_SECP256K1_PUBKEY` in the repo-root `.env` by the integration setup. |

These set the *starting* config. Switching Midnight network in the running app
resets every endpoint to that network's published defaults, so stagenet (whose
endpoints this repo deliberately does not publish) has to be selected through
the environment.

The EVM chain id is not cosmetic: the vault seals `eip155:<chainId>` into its
contract at initialize, and that is the routing key the MPC signs against.
Nothing here yet proves the RPC actually serves the chain id you configured, so
a mismatch is currently undetected: the balance reads go out over whatever the
RPC is, and a wrong chain id shows as balances that do not match the wallet's
own. Detecting it needs a live `eth_chainId` call compared against the config,
and that check has still to be written.

## Where the chain wiring goes

Every read is a TanStack Query query, and a component never fetches for itself:

1. Both wallet connections are contexts, published to components through
   `useWalletConnections` as one shape per chain.
2. Contract state is a query keyed by the deployed address:
   `useVaultEvmAddress` reads the vault's own EVM account out of its ledger.
3. EVM chain reads go through wagmi's client for the configured chain
   (`useTrackedTokens` for what a token says about itself,
   `useAccountBalances` for what an account holds).
4. Still to come: deposit and withdrawal mutations, each refreshing the
   balances above on success.

The Midnight side reaches the chain through
`@midnight-examples/erc20-vault-contract`, whose export surface is
environment-agnostic so a browser can import it directly.
