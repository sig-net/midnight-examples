# erc20-vault UI

The browser front end for the erc20-vault example: a single-page app over the
deployed vault, walked through as three steps.

1. **Connect wallets.** One Midnight wallet and one EVM wallet, each either a
   browser extension or an in-app seed wallet installed from a pasted hex seed.
2. **Derive the deposit address.** One signature from the Midnight wallet
   establishes your vault identity and the EVM deposit account only the MPC
   network can sign for.
3. **Interact with the vault.** Track the ERC20 tokens you care about and see
   what every account in the flow holds. Depositing and withdrawing are still
   to come.

## Quickstart

From a fresh clone to the running demo against a local stack. The
prerequisites (Node 20+, Yarn 4 via Corepack, the compact toolchain, a docker
engine with 16 GB of RAM allocated) are in the repository root's
[README](../../../README.md).

1. Stand the stack up and deploy the contracts, from the repository root.
   Before `docker compose up -d`, put a Sepolia RPC URL in the repo-root
   `.env` as `SEPOLIA_FORK_RPC_URL=<url>` (e.g. an Infura or Alchemy Sepolia
   endpoint): the local EVM forks Sepolia so real USDC is present, and
   compose only adds the fork flag when the value is set.

   ```sh
   corepack enable
   yarn install
   compact update 0.33.0-rc.2
   yarn compile
   docker compose up -d
   yarn test:erc20-vault:e2e tests/deploy-only.test.ts
   ```

   The last command generates and funds wallets, deploys the contracts,
   initialises the vault, and appends everything the demo needs to the
   repo-root `.env`. The first run takes roughly ten minutes (the vault's zk
   proving keys compile), and reruns skip whatever `.env` already holds.

   When it is green, open the repo-root `.env`: the demo uses five of its
   values. The two user seeds sit in their generated-seed blocks
   (`MIDNIGHT_USER1_WALLET_SEED` near the top, `EVM_USER1_WALLET_SEED` in its
   own block), and the run's final append is the hand-off block with the
   other three, which looks like this (every value differs per machine):

   ```
   # appended by the erc20-vault setup (2026-08-07T09:40:58.408Z): UI hand-off values
   MPC_ROOT_PUBLIC_KEY=0x03a8e3c3ffbe8f986da894bf785d7c60b8eb4047205e089f095f173ca2446341de
   MIDNIGHT_VAULT_CONTRACT_ADDRESS=439fa174127586474ad01552af3372033ebf624e68558a72e030a7506b445ad0
   EVM_ERC20_CONTRACT_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
   ```

2. Run `yarn dev:erc20-vault-ui` and open http://localhost:5173.

3. Hand the app the `.env`'s `MPC_ROOT_PUBLIC_KEY` and
   `MIDNIGHT_VAULT_CONTRACT_ADDRESS`. Two equivalent ways, pick either:

   - **Through the running app** (easiest): open the gear in the header and
     paste the two values into the "ERC20 vault" section's "MPC public key"
     and "Contract address" fields. An edit lasts until the page reloads.
   - **Through the environment** (survives reloads): create
     `examples/erc20-vault/ui/.env.local` mirroring the two values, then
     restart the dev server:

     ```
     VITE_MPC_ROOT_PUBLIC_KEY=<the .env's MPC_ROOT_PUBLIC_KEY>
     VITE_MIDNIGHT_VAULT_CONTRACT_ADDRESS=<the .env's MIDNIGHT_VAULT_CONTRACT_ADDRESS>
     ```

4. Walk the steps:
   - **Connect wallets**: choose "Use a seed wallet" on both rows. Paste the
     `.env`'s `MIDNIGHT_USER1_WALLET_SEED` into the Midnight dialog and its
     `EVM_USER1_WALLET_SEED` into the EVM dialog: two independent wallets,
     one per chain, both funded by the setup. The Midnight side syncs against
     the indexer, so its first balance read can take a moment.
   - **Derive the deposit address**: with a seed wallet the signature happens
     in-app, no prompt.
   - **Interact with the vault**: paste the `.env`'s
     `EVM_ERC20_CONTRACT_ADDRESS` into the tracked-tokens field to see the
     USDC balances (real Sepolia USDC, present on the local fork).

Within this package the scripts are `dev`, `build`, `preview` and `test`.
`build` typechecks before it bundles, so a type error fails the build.

## Configuration

The app starts on the local standalone stack (`undeployed`) with the endpoint
defaults published by `@midnight-examples/chain-config`. Overrides go in a
`.env.local` file in this directory (only `VITE_`-prefixed variables reach the
browser), and every value can also be edited at runtime through the header's
configuration panel (an edit lasts until the page reloads).

| Variable | Effect |
| --- | --- |
| `VITE_MIDNIGHT_NETWORK_ID` | Which network to start on. Startup fails naming the valid ids if this is not one of them. |
| `VITE_MIDNIGHT_INDEXER_URL` | Indexer GraphQL over HTTP. Setting it also derives the WebSocket URL, so the two cannot point at different hosts. |
| `VITE_MIDNIGHT_INDEXER_WS_URL` | Indexer GraphQL over WebSocket, when it is not simply the twin of the HTTP URL. |
| `VITE_MIDNIGHT_NODE_URL` | Midnight node RPC. |
| `VITE_MIDNIGHT_PROOF_SERVER_URL` | Proof server. Stays local by default: it sees private witness data. |
| `VITE_EVM_RPC_URL` | JSON-RPC endpoint of the EVM chain. Defaults to the local anvil compose service. |
| `VITE_EVM_CHAIN_ID` | The EVM chain id to expect. Defaults to anvil's 31337, and must match what the RPC actually serves. |
| `VITE_EVM_EXPLORER_URL` | Block explorer base URL, for linking transactions and addresses. |
| `VITE_MPC_ROOT_PUBLIC_KEY` | The MPC network's root public key (secp256k1 hex, compressed or uncompressed, `0x` optional). Deposit addresses derive from it. Unset, everything else works and the app says the address cannot be derived. The quickstart's setup appends the local value to the repo-root `.env` as `MPC_ROOT_PUBLIC_KEY`. |
| `VITE_MIDNIGHT_VAULT_CONTRACT_ADDRESS` | The vault's Midnight contract address on the starting network, overriding the per-network deployment table. The quickstart's setup appends the local value to the repo-root `.env`. |

These set the *starting* config. Switching Midnight network in the running app
resets every endpoint to that network's published defaults, so stagenet (whose
endpoints this repo deliberately does not publish) has to be selected through
the environment.
