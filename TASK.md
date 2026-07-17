# TASK — remaining work in midnight-examples

**How to use this file:** the single source of truth for what REMAINS in this
repo. Work one task at a time; tick the box, append the commit hash, and record
outcomes in the Decision Log at the bottom. Every phase of work ends green
(`yarn build && yarn test`; e2e via the `/e2e` skill) and committed. Read
[AGENTS.md](AGENTS.md) first — every rule applies to every line.

Rewritten 2026-07-17. The original erc20-vault **port plan is complete**
(Phases 0–8: scaffold → lib → contract → harness → flows → five e2e specs →
CI → protocol-repo split; PR #1 open, CI green, SDK publishes done, protocol
repo pruned to singleton + SDK + minimal caller). The full plan, source→dst
maps, session protocol, and risks live in git history:
`git log --follow -- TASK.md`.

The two tasks marked **KEY** came out of the 2026-07-17 final coverage recon
(protocol repo task.md D29): they are the only substantive gaps between the
old MVP's test surface and this repo.

Durable reference for old-MVP sources: the protocol repo's pre-refactor main
is pinned at commit `99ee0c6` (repo `sig-net/midnight-integration`, local
checkout `~/Projects/github.com/sig-net/midnight-erc20-vault`). Read old files
with `git -C <that checkout> show 99ee0c6:<path>` — do NOT use `origin/main`,
which will soon point at the refactor.

---

## Tasks

- [x] **T.1 (KEY) Bearer-transfer ownership handoff test.** `3445bc8` — live
      spec `tests/bearer-transfer.test.ts` (11 tests, green against the local
      stack; see Decision Log D30). The vault tokens
      are shielded *bearer* assets: the claim on the locked ERC20 travels with
      possession of the coin, transferable by an ordinary wallet-to-wallet
      Midnight transfer — no vault involvement, no depositor registry. The old
      MVP's STEP 8 proved it end to end; it is the only old test scenario with
      no twin anywhere (`transferTransaction` appears nowhere in this repo).
      Reference: `99ee0c6:boilerplate/contract-cli/src/test/vault.e2e.test.ts`
      (STEP 8).
      Scenario: wallet A transfers its entire shielded vault-token balance to
      wallet B (plain `transferTransaction`); assert A (balance 0) can no
      longer fund a withdraw, and B can run a withdraw to completion.
      Cheapest home is the simulator suite
      (`examples/erc20-vault/contract/tests/erc20-vault.test.ts`) if it can
      express moving the coin between identities; otherwise a live variant
      riding an existing e2e spec (the failure-refund spec already builds a
      second wallet — see `deposit-claimant-not-caller.test.ts` for the
      second-wallet plumbing).
      *Done when:* a test proves old-owner-loses / new-owner-gains.

- [ ] **T.2 (KEY) Withdraw segment-safety: verify what happens without
      `kernel.checkpoint()`.** Midnight transactions are two-phase — a
      guaranteed segment (always applies if the tx lands) and a fallible
      segment (can fail at block application, rolling back only fallible
      effects) — so partial application is a real outcome, and
      `kernel.checkpoint()` adds a commit point: effects before it survive a
      failure after it.
      The vault's `withdraw` (`contract/src/erc20-vault.compact`) does
      `receiveShielded(coin)` and THEN a fallible CROSS-CONTRACT
      `signetNotifier.notifyBidirectionalSignatureRequest(...)`, with no
      checkpoint. The assumption (never demonstrated) is that both sit in one
      rollback unit, so a failed notify reverts the coin take too — safe. If
      they can end up split, a failed notify strands the coin (taken, but no
      request/notification recorded).
      NOTE: the old MVP "fixed" its own layout with a checkpoint after the
      take (`99ee0c6`, PR #3) — that does NOT transplant here: main has no
      cross-contract call (only infallible same-ledger inserts after its
      checkpoint). Placing a checkpoint after OUR take, before the fallible
      notify, would CREATE the stranding hazard.
      Experiment: force the notify to fail and observe the coin. Cheapest
      lever: the notifier address is sealed at `initialize` — initialize a
      vault against a bogus/absent signet contract address (or a signet
      contract whose circuit rejects) and drive a withdraw; assert the
      withdrawer's balance is unchanged and no request/refund marker exists.
      *Done when:* the outcome is recorded in the Decision Log below — either
      "verified: one rollback unit, coin returned" (document it in the
      contract next to the notify call) or the circuit is restructured, with
      the reasoning logged.

- [ ] **T.3 Over-balance withdraw live assert (low).** Old MVP #10: a
      withdraw exceeding the caller's vault-token balance fails at the WALLET
      level (the spend can't be funded) — no simulator twin possible. Cheap
      rider on an existing e2e spec: `expect(withdraw(balance + 1n)).rejects`.

- [ ] **T.4 `cron-latest-sdk.yaml` (from the README TODOs block).** A
      scheduled full-matrix run against the *latest published*
      `@sig-net/midnight*` — catches silent example rot AND breakage in newly
      published SDK versions. Remove the block from README.md when this lands.

## Operational notes (not tasks — clear them as you touch each checkout)

- **Merge PR #1** (`port/erc20-vault` → `main`) — user action; all port
  follow-ups (SDK publishes, links removed, CI green npm-only) are resolved.
- **Stale `.env` contract addresses** in BOTH checkouts (this one and
  `~/Projects/github.com/midnight-examples` @ `port/erc20-vault-stable`): the
  local chain was reset after those values were minted. Before the next e2e
  run, comment out `MIDNIGHT_VAULT_CONTRACT_ADDRESS`,
  `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`, `ERC20_ADDRESS`, `EVM_VAULT_ADDRESS`,
  `EVM_USER_ADDRESS` so setup redeploys — and make sure the protocol repo's
  stack is down first (`docker compose --profile fakenet down` there); the
  two stacks share host ports.

---

## Decision Log

Append-only. Port-era decisions live in git history of this file and in
HANDOFF.md's history (`git log --follow -- TASK.md HANDOFF.md`).

<!-- Append new decisions below this line. -->

- **D30 (2026-07-17, T.1) Bearer-transfer handoff proven live; runtime NIGHT
  movement poisons the local chain's dust proofs.** T.1 landed as a LIVE spec
  (`tests/bearer-transfer.test.ts`, `3445bc8`): the simulator cannot express
  either assertion — "A can no longer fund a withdraw" and "B can" are both
  WALLET funding semantics (the simulator's coins are bare structs). The spec
  proves the full arc: A deposits+claims, transfers its ENTIRE shielded
  vault-token balance to B with a plain `transferTransaction`, A's withdraw
  dies client-side (`InsufficientFunds`, `signetNonce` unchanged — no ledger
  trace), B runs withdraw → MPC sign → broadcast → success attestation →
  `completeWithdraw` to settled completion. Findings along the way:
  1. **Wallet B must be a genesis-endowed seed (`00…02`), never a fee-funded
     fresh seed.** The first attempt fee-funded seed `…44` from A (NIGHT
     transfer + dust registration, mirroring the old MVP's
     `fundWalletForFees`); from that moment EVERY wallet's dust spend proofs
     failed node verification — `1010: Invalid Transaction: Custom error:
     170` (`InvalidDustSpendProof`) on every submit, all wallets, all tx
     shapes — and nothing but a chain reset recovered it (re-registration,
     fresh sessions, proof-server restarts all ineffective; wallet-sdk
     5.0.0-beta.2 against the compose node). The dev chain genesis endows
     seeds `…01`/`…02`/`…03` with registered, dust-generating NIGHT, so a
     second SPENDING wallet needs no runtime funding at all. The helper was
     deleted; the trap is a ground rule + failure-reading entry in the e2e
     skill runbook.
  2. **The prove timeout in lib's cross-contract proof provider rose from
     midnight-js's 5-minute default to 15 minutes**: under host CPU load the
     arrange deposit's prove exceeded 5 minutes and the client aborted
     (`'prove' returned an error: AbortError`) proves that completed fine
     once given headroom.
  3. `runDepositRoundTrip`'s resume path serves mid-flight recovery only (a
     CLAIMED deposit is no longer on the ledger, so its reader-based resume
     throws); the spec's arrange step instead self-skips when A already holds
     the tokens AND the vault's EVM account holds the matching ERC20 — both
     sides checked because a failure-refund-style drain leaves tokens without
     EVM custody.
