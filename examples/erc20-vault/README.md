# ERC20 Vault

This example demonstrates bridging ERC20 assets from an EVM chain into shielded
tokens on Midnight, and back again, without a custodian. A Midnight contract
(the vault) owns an EVM account whose key nobody holds. The address is derived
from the Signature Network MPC's root public key, and every EVM transaction the
vault sends is signed by the MPC network on the vault's request via the
[sign-bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional).

What this example demonstrates, end to end:

- A Compact contract requesting EVM transaction signatures from the Signature
  Network singleton contract with a cross-contract call on Midnight.
- The MPC observing the request, signing the EVM transaction (secp256k1), and
  later attesting the EVM outcome (Schnorr over Jubjub). Both responses are
  posted back on Midnight.
- The vault verifying that attestation in-circuit and minting or burning
  shielded vault tokens accordingly, including a refund branch for when the
  EVM leg fails.

## Architecture

![Demo architecture](docs/demo-architecture.drawio.svg)

### Deposit: EVM ERC20 → shielded vault tokens

1. Fund the derived accounts. The vault's EVM address (derivation path
   `"vault"`) and the user's EVM address (path set to the user's identity
   commitment) are both derived from the MPC root public key. The user's
   account holds the ERC20 being deposited plus some ETH for gas. The
   local-stack setup pipeline does all of this funding automatically.
2. The user calls `deposit()` on the vault contract on Midnight. The vault
   composes the `transfer(vaultEvmAddress, amount)` calldata in-circuit,
   records a pending signature request on its own ledger, and notifies the
   Signature Network singleton with a cross-contract call.
3. The MPC network discovers the notification, resolves the request from the
   vault's ledger, and posts a secp256k1 signature over the EVM sweep
   transaction onto the singleton (`pollSignatureResponse`).
4. Any client assembles the signed transaction and broadcasts it to the EVM
   chain (`broadcastEvm`). The ERC20 moves from the user to the vault.
5. The MPC observes the mined receipt and posts a Schnorr attestation of the
   outcome (`pollRespondBidirectional`).
6. The depositor calls `claim()`, presenting the attestation to the vault. The
   vault re-verifies it in-circuit (MPC key hash, Schnorr signature, EVM
   success flag, caller identity) and mints shielded vault tokens to the
   caller, or to an optional alternate recipient's coin public key. The
   request is consumed, protecting against double claims.

### Withdraw: shielded vault tokens → EVM ERC20

Withdrawal is the mirror image. `withdraw()` escrows (burns) the caller's
shielded vault tokens and records a signature request for an ERC20 transfer
out of the vault's derived account, pinning a refund commitment of the
caller's identity. The MPC signs, the transfer is broadcast, the MPC attests,
and `completeWithdraw()` verifies the attestation in-circuit and branches on
the EVM outcome:

- On success the withdrawal finalises and the escrowed value stays burned.
- On failure (e.g. the transfer reverted) the escrowed value is re-minted to
  the withdrawer, who proves the pinned refund commitment. The refund mints
  under a fresh random nonce so that it is unlinkable to the request.

Either way the request and its pending-withdrawal marker are consumed,
protecting against double settlement.

## Package layout

| Package | What it is |
|---|---|
| [`contract/`](contract/) | The Compact contract (`src/erc20-vault.compact`), its witnesses, a curated environment-agnostic export surface, simulator unit tests, and a deploy entrypoint. Its dependency list (`@sig-net/midnight`, `@sig-net/midnight-contract` and the compact tooling) is the minimal integration surface. |
| [`integration-tests/`](integration-tests/) | The executable documentation: typed in-process flow functions (`src/flows/`) driving every leg above, the setup pipeline that deploys the whole stack, six e2e specs, and the example's TestUSDC ERC20. |

## Running it

Everything runs from the repo root against the local docker stack (Midnight
node, indexer, proof server, anvil EVM, fakenet MPC responder). No
pre-existing `.env` is required. The setup pipeline creates one and records
everything it deploys so that later runs reuse the same contracts.

```sh
corepack enable
yarn install
compact update 0.33.0-rc.0          # Exact version required.
yarn compile:erc20-vault:zk         # ~10 min zk key generation, background it
docker compose up -d
yarn test:erc20-vault:e2e           # the six e2e specs, serially, bail on first failure
```

Offline checks that need no stack and no proving keys beyond `yarn compile`:

```sh
yarn compile:erc20-vault            # generate src/managed (skip-zk)
yarn build                          # typecheck everything
yarn test:erc20-vault               # simulator unit tests + offline-skipped e2e files
```

Deploy a fresh vault by hand (the e2e setup does this automatically when the
`.env` has no vault address):

```sh
yarn deploy:erc20-vault
```

**TIP:** If you are using Claude Code you can ask it to run these tests for
you using this [skill](../../.claude/skills/e2e/SKILL.md). It knows the whole
operational runbook (rerun vs redeploy modes, the fakenet responder hand-off,
failure recovery) and will drive it for you.

## The e2e suite

Six specs run serially in a pinned order (see
`integration-tests/vitest.config.ts`). `happy-day-e2e` runs first because it
initialises the vault and cycles the funds that the later flows build on.
Each spec is rerun-tolerant against kept contract addresses and prints resume
ids in banners as it goes, for recovering a run that died mid-flow.

| Spec | Tests | What it proves | Resume var(s) |
|---|---|---|---|
| `happy-day-e2e` | 15 | Full deposit + withdraw round trips, every leg asserted (incl. the MPC-convention reads a responder does) | `DEPOSIT_REQUEST_ID`, `WITHDRAW_REQUEST_ID` |
| `deposit-withdrawal-failure-refund` | 9 | A withdraw whose EVM transfer reverts ends in an in-circuit REFUND of the escrowed shielded value | `FAILURE_REFUND_DEPOSIT_REQUEST_ID`, `FAILURE_REFUND_WITHDRAW_REQUEST_ID` |
| `deposit-claimant-not-caller` | 6 | `claim` can direct the mint to a different wallet's coin public key, discovered from chain data alone | `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID` |
| `benchmark` | 13 | Per-leg wall-clock report of both round trips (`BENCHMARK_TIMINGS_JSON` greppable line) | `BENCHMARK_DEPOSIT_REQUEST_ID`, `BENCHMARK_WITHDRAW_REQUEST_ID` |
| `false-claimer` | 6 | A deposit recorded for identity A is NOT claimable by identity B, even with the valid MPC attestation | `FALSE_CLAIMER_DEPOSIT_REQUEST_ID` |
| `bearer-transfer` | 11 | Shielded vault tokens are bearer assets: a plain Midnight transfer hands the claim to wallet B, the emptied wallet A can no longer withdraw, and B completes a full withdraw on the transferred balance | `BEARER_TRANSFER_DEPOSIT_REQUEST_ID`, `BEARER_TRANSFER_WITHDRAW_REQUEST_ID` |

60 tests total. A rerun against kept contract addresses (a populated `.env`)
completes in roughly 25–35 minutes on a laptop. A fresh deployment adds the
setup pipeline's deploys (a few minutes) on top, and a cold clone adds the
~10 minute zk key generation. The claim/settle proofs are the heavy legs: the
proof server peaks above 12 GiB, so give the docker VM 16 GB.

## Test Run Recovery

The proof server being OOM-killed mid-run is routine on a 16 GB Docker VM and
not a defect. It presents as a spec failing with
`connect ECONNREFUSED 127.0.0.1:6300`, with `docker ps -a` showing
`midnight-proof-server` as `Exited (137)` (confirm with
`docker inspect midnight-proof-server --format '{{.State.OOMKilled}}'`).
You do not need to start over. Every on-chain step that already completed
stays completed, and each spec prints its request ids in banners as it goes.

To recover:

1. `docker restart midnight-proof-server`
2. Rerun the same spec file, passing the request id it printed via the spec's
   resume env var (see the table above) so that it resumes the pending
   request instead of spending a fresh deposit:

   ```sh
   DEPOSIT_REQUEST_ID=<id from the banner> \
     yarn test:erc20-vault:e2e tests/happy-day-e2e.test.ts
   ```

The flows are rerun-tolerant: already-mined EVM broadcasts skip through
idempotently and already-claimed or settled requests are skipped cleanly. If
the spec died on the proving call itself and printed no request-id banner
then there is nothing to resume. Rerun the spec plain and it spends a fresh
deposit. On the rerun the interrupted proof is the first one served by a
fresh proof server, so the rest of the file fits in the remaining headroom.

One corner case: if the proof server died while the fakenet responder was
posting a response, that request strands unresponded (a signature poll then
times out even though the responder logged the request). Recover with
`docker compose --profile fakenet restart fakenet` (its startup backfill
re-posts the missing responses), then rerun with the resume var as above.

**TIP:** If you are using Claude Code you can ask it to run the suite for you
using this [skill](../../.claude/skills/e2e/SKILL.md). It will handle the
proof server restarts and resume vars between failures for you.
