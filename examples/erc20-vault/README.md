# ERC20 Vault

Bridge ERC20 assets from an EVM chain into **shielded tokens on Midnight** —
and back — without a custodian. A Midnight contract (the vault) owns an EVM
account whose key nobody holds: the address is derived from the Signature
Network MPC's root public key, and every EVM transaction the vault sends is
signed by the MPC network on the vault's request, via the
[sign-bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional).

What this example demonstrates, end to end:

- A Compact contract requesting **EVM transaction signatures** from the
  Signature Network singleton contract (cross-contract call on Midnight).
- The MPC observing the request, signing the EVM transaction (secp256k1),
  and later **attesting the EVM outcome** (Schnorr over Jubjub), with both
  responses posted back on Midnight.
- The vault verifying that attestation **in-circuit** and minting/burning
  shielded vault tokens accordingly — including a refund branch when the EVM
  leg fails.

## Architecture

![Demo architecture](docs/demo-architecture.drawio.svg)

### Deposit: EVM ERC20 → shielded vault tokens

1. **Fund the derived accounts** — the vault's EVM address (derivation path
   `"vault"`) and the user's EVM address (path = the user's identity
   commitment) are derived from the MPC root public key. The user's account
   holds the ERC20 being deposited plus gas. (The local-stack setup pipeline
   does all funding automatically.)
2. **`deposit()`** — the user calls the vault contract on Midnight. The vault
   composes the `transfer(vaultEvmAddress, amount)` calldata in-circuit,
   records a pending signature request on its own ledger, and cross-contract
   notifies the Signature Network singleton.
3. **MPC signs** — the MPC network discovers the notification, resolves the
   request from the vault's ledger, and posts a secp256k1 signature over the
   EVM sweep transaction onto the singleton (`pollSignatureResponse`).
4. **Broadcast** — any client assembles the signed transaction and broadcasts
   it to the EVM chain (`broadcastEvm`); the ERC20 moves user → vault.
5. **MPC attests** — the MPC observes the mined receipt and posts a Schnorr
   attestation of the outcome (`pollRespondBidirectional`).
6. **`claim()`** — the depositor presents the attestation to the vault, which
   re-verifies it in-circuit (MPC key hash, Schnorr signature, EVM success
   flag, caller identity) and mints shielded vault tokens — to the caller, or
   to an optional alternate recipient's coin public key. The request is
   consumed (double-claim protection).

### Withdraw: shielded vault tokens → EVM ERC20

The mirror image. **`withdraw()`** escrows (burns) the caller's shielded
vault tokens and records a signature request for an ERC20 transfer FROM the
vault's derived account, pinning a refund commitment of the caller's
identity. The MPC signs, the transfer is broadcast, the MPC attests, and
**`completeWithdraw()`** verifies the attestation in-circuit and branches on
the EVM outcome:

- **Success** — the withdrawal finalizes; the escrowed value stays burned.
- **Failure** (e.g. the transfer reverted) — the escrowed value is re-minted
  to the withdrawer, who proves the pinned refund commitment. The refund
  mints under a fresh random nonce, unlinkable to the request.

Either way the request and its pending-withdrawal marker are consumed
(double-settle protection).

## Package layout

| Package | What it is |
|---|---|
| [`contract/`](contract/) | The Compact contract (`src/erc20-vault.compact`), its witnesses, a curated environment-agnostic export surface, simulator unit tests, and a deploy entrypoint. Its dependency list — `@sig-net/midnight`, `@sig-net/midnight-contract`, the compact runtime — is the minimal integration surface. |
| [`integration-tests/`](integration-tests/) | The executable documentation: typed in-process flow functions (`src/flows/`) driving every leg above, the setup pipeline that deploys the whole stack, five e2e specs, and the example's TestUSDC ERC20. |

## Running it

Everything runs from the repo root against the local docker stack (Midnight
node + indexer + proof server, anvil EVM, fakenet MPC responder). No
pre-existing `.env` is required — the setup pipeline creates one and records
everything it deploys, so later runs reuse the same contracts.

```sh
corepack enable
yarn install
compact update                      # install the compact toolchain
yarn compile:erc20-vault:zk         # ~10 min zk key generation — background it
docker compose up -d
yarn test:erc20-vault:e2e           # the five e2e specs, serially, bail on first failure
```

Offline checks (no stack, no proving keys beyond `yarn compile`):

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

For the full operational runbook — rerun vs redeploy modes, the fakenet
responder hand-off, reading failures (proof-server OOM, resume env vars) —
see [`.claude/skills/e2e/SKILL.md`](../../.claude/skills/e2e/SKILL.md).

## The e2e suite

Five specs, run serially in a pinned order (see `integration-tests/vitest.config.ts`);
`happy-day-e2e` runs first because it initializes the vault and cycles the
funds the later flows build on. Each spec is rerun-tolerant against kept
contract addresses and carries a resume env var for recovering a run that
died mid-flow (printed in its banners).

| Spec | Tests | What it proves | Resume var(s) |
|---|---|---|---|
| `happy-day-e2e` | 15 | Full deposit + withdraw round trips, every leg asserted (incl. the MPC-convention reads a responder does) | `DEPOSIT_REQUEST_ID`, `WITHDRAW_REQUEST_ID` |
| `deposit-withdrawal-failure-refund` | 9 | A withdraw whose EVM transfer reverts ends in an in-circuit REFUND of the escrowed shielded value | `FAILURE_REFUND_DEPOSIT_REQUEST_ID`, `FAILURE_REFUND_WITHDRAW_REQUEST_ID` |
| `deposit-claimant-not-caller` | 6 | `claim` can direct the mint to a different wallet's coin public key, discovered from chain data alone | `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID` |
| `benchmark` | 13 | Per-leg wall-clock report of both round trips (`BENCHMARK_TIMINGS_JSON` greppable line) | `BENCHMARK_DEPOSIT_REQUEST_ID`, `BENCHMARK_WITHDRAW_REQUEST_ID` |
| `false-claimer` | 6 | A deposit recorded for identity A is NOT claimable by identity B, even with the valid MPC attestation | `FALSE_CLAIMER_DEPOSIT_REQUEST_ID` |

49 tests total. A rerun against kept contract addresses (populated `.env`)
completes in roughly 25–35 minutes on a laptop; a fresh deployment adds the
setup pipeline's deploys (a few minutes) on top, and a cold clone adds the
~10 minute zk key generation. The claim/settle proofs are the heavy legs
(the proof server peaks above 12 GiB — give the docker VM 16 GB).
