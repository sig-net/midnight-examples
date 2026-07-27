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

## Relationship to the SDK

These primitives duplicate `@sig-net/midnight-contract-deploy`'s `plumbing/`
module, which a browser cannot import: that package depends on
`@effect/platform-node`. This package exists to close that gap, and should be
deleted once the client-agnostic `@sig-net/midnight` exports the same values.
