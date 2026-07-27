# @midnight-examples/chain-config

Chain configuration primitives shared across the workspace: the named network
ids, each network's default endpoints, and the `MidnightNodeConfig` shape that
carries them.

## This package is isomorphic, and that is the point

It runs unchanged in **both** a browser bundle and Node. That is what lets an
example's `ui` member and the Node deploy scripts, flows and test harness resolve
their endpoints from one source of truth instead of two that drift.

Keeping it that way means the package contains data, types and pure functions
only:

- no runtime dependencies (the `dependencies` block is empty and stays empty)
- no Node builtins, `process`, or `Buffer`
- no DOM globals
- no reading of any environment, in either direction

Reading configuration *out* of an environment belongs to the consumer, since it
differs per runtime: `getMidnightNodeConfig` in `@midnight-examples/lib` reads
`process.env`, and a `ui` member reads `import.meta.env`. Both resolve against
the defaults published here.

Both halves of the guarantee break silently rather than failing a build, so the
package checks itself: `src/` compiles with no Node types, and its test suite
scans the sources for globals belonging to either runtime. `yarn build && yarn
test` runs both.

## What it exports

| Export | Purpose |
| --- | --- |
| `NetworkId`, `NETWORK_IDS` | The named networks, as a type and a runtime list for validation. |
| `isLocalStandaloneNetwork` | Whether a network's genesis wallet is pre-funded, which is true only of the local stack. |
| `MidnightNodeConfig`, `Endpoints` | The endpoint set needed to reach a chain, with and without the network id. |
| `DEFAULT_ENDPOINTS` | Per-network endpoint defaults. Stagenet's are deliberately blank: this repo does not publish them. |
| `LOCAL_PROOF_SERVER` | The local proof server URL. It sees private witness data, so it is never remote. |
| `FAUCET_URLS` | Published faucet URLs, for underfunded-wallet hints. |
| `indexerWsUrlFromIndexerUrl` | Derives the indexer's WebSocket URL from its HTTP URL, so the two cannot point at different hosts. |
| `EvmChainConfig` | Everything needed to reach one EVM chain: its id, JSON-RPC endpoint and optional block explorer. |
| `LOCAL_EVM_CHAIN` | The local dev chain, which is the `evm` compose service running anvil on chain id 31337. |
| `evmCaip2ChainId` | Derives an EVM chain's CAIP-2 id (`eip155:<id>`), the form an example seals into its contract and the MPC routes on. |

The EVM side is deliberately much smaller than the Midnight side. An EVM chain
is reached through a single JSON-RPC endpoint, so there is no endpoint set to
keep consistent and no named-network table to select from. The chain id is the
one value that carries real weight, since an example seals `eip155:<chainId>`
at initialize: a config that disagrees with the chain its RPC serves produces
requests the vault will not honour. Verifying that agreement needs a live
`eth_chainId` call, so it belongs to the consumer, not here.

## Layout, and why the names differ per chain

```
src/
  midnight/   # networks.ts, endpoints.ts
  evm/        # chain.ts
```

The exports stay flat, so the names have to disambiguate themselves. The EVM
ones therefore carry an explicit `Evm`/`EVM_` marker: a bare `LOCAL_CHAIN` at a
call site would not say which chain it meant.

The Midnight ones are the deliberate exception. They match
`@sig-net/midnight-contract-deploy`'s `plumbing/` exports verbatim and
unprefixed, so that deleting this package in favour of the SDK stays a change
of import path rather than a rename. The `midnight/` directory is what tells a
reader which chain they belong to.

## What is NOT here: Midnight's CAIP-2 id

Midnight has one, and it does not belong in this package. `@sig-net/midnight`
exports it as `MIDNIGHT_TESTNET_CHAIN_ID` (`"midnight:testnet"`), a fixed
protocol constant rather than anything derived from a network id: the MPC's
key derivation hashes it verbatim as part of
`keccak256("<prefix>:<chainId>:<requester>:<path>")`. Deriving a per-network
variant here would invent identifiers the MPC has never seen, and anything
passing one into derivation would silently produce different keys. Import the
SDK's constant instead.

## Relationship to the SDK

These primitives duplicate `@sig-net/midnight-contract-deploy`'s `plumbing/`
module, which a browser cannot import: that package depends on
`@effect/platform-node`. This package exists to close that gap, and should be
deleted once the client-agnostic `@sig-net/midnight` exports the same values.
