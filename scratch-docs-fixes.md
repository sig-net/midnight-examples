# Documentation fixes checklist

Audit date: 26 September 2026.

Examples baseline: `85b1d3514739eb3bd9f653b040a6715bb33aaf23` on `docs/align-with-implementation`.
Reference guide: the local integration checkout at `3d28dc74834ea0b4ff3786e6680d5598ae08376b`, especially its Integrator Guide and runtime height checks.

This file tracks documentation work and its verification evidence. Priorities mean:

- **P1:** an integrator can construct the wrong request, derive the wrong account, misunderstand authorisation or omit a required transaction or check.
- **P2:** incorrect operational guidance, missing coverage or broken navigation.
- **P3:** clarity, consistency and editorial maintenance.

## Execution plan

Run the following stages in order. Within a stage, separate lanes may run in parallel. Each task retains its own checkbox and context below.

| Stage | Execution order | Parallel work |
| --- | --- | --- |
| 1. Establish evidence and diagram rules | T01 → T02 | T33 → T03 → T04 can run alongside the evidence work. T33 and T03 must encode the grouped actor-map decision below. |
| 2. Prepare shared explanations | T05 → T06 → T10 → T14 | Keep these sequential for a simple hand-off. This completes the common foundations for the walkthroughs. |
| 3. Write pages and prepare the actor map | Vault README lane: T11 → T09 → T12 → T13 → T15 → T16 → T17 → T18 → T19 → T20 | Run T21, T22, T23, T24 and T25 independently. T07 and T08 can each run in their own lane. Start T26 after T11 and T09 finish. |
| 4. Render the diagrams and finish operational instructions | T27 after T26 + T21, T28 after T26 + T22, T29 after T26 + T23, T30 after T26 + T24, T31 after T26 + T25 | The five diagram tasks can run independently as their prerequisites finish. T32 follows T08. T34 follows T15, T16, T18 and T19. These may start during stage 3 once their inputs are ready. |
| 5. Verify the complete set | T35 | Run after every preceding task is complete or has an explicitly recorded blocker. |

**File ownership:** keep all vault README edits on one sequential lane. Keep T05, T06 and T07 sequential because they edit the same Compact file. Give each walkthrough and each diagram pair one owner. Agents report task results to the coordinating agent, which updates this checklist to avoid concurrent edits here. Respect the available agent limit by taking ready tasks in batches.

### Actor-map scope decision

The vault actor map shows **state and one grouped circuit line per operation**. For example, the deposit line can read `start/send/completeDeposit(...)`. This is visual shorthand for multiple circuits, not the name of a callable circuit. Use source-verified member names when choosing each group, including settlement or refund variants where applicable. Keep the actual call order in the walkthroughs and flow diagrams.

Retain the actors and their relationships. Within the vault contract box, show the current exported ledger state and one compact line each for deposit, withdraw, swap, supply and redeem. Omit a separate witness inventory and an exhaustive circuit list. Document configuration, administration, approvals and shared queue maintenance in the README and relevant flow pages. The README remains the complete circuit inventory.

T33 and T03 align the repository instructions and diagram guide with this requested scope, including an explicit exception to verbatim circuit labels for grouped actor-map lines. Flow diagrams may expand a group into the concrete circuits used by that flow, retaining the actor map's visual styles. They must not be required to copy grouped labels byte-for-byte. T26 implements the actor map, and T27–T31 implement the individual flow diagrams.

## Stage 1 results and hand-off (27 September 2026)

**Completed and reviewed:** T01, T02, T33, T03 and T04. T02 completes the investigation and decision note, with two reproduced implementation defects still open. Completing T02 does not establish protocol compliance. Later documentation must use the findings below and must not promise replay protection until those defects have been addressed and retested.

### T01: validation environment restored

The immutable install restored `@sig-net/midnight`, `@sig-net/midnight-contract` and `@sig-net/midnight-contract-deploy` to the committed `0.24.0-rc.4` versions. The registry returned no deprecation field for those releases. The audit reported two existing transitive deprecations, `@substrate/connect@0.8.11` and `node-domexception@1.0.0`. The install used a project-local cache and left manifests and `yarn.lock` unchanged. Yarn reported existing Effect peer-dependency warnings.

| Executed verification | Result |
| --- | --- |
| `YARN_ENABLE_GLOBAL_CACHE=false yarn install --immutable` | Passed with peer-dependency warnings |
| `yarn compile` | Passed, regenerating the ignored contract output |
| `yarn format:check && yarn lint && yarn build && yarn test` | Format, lint and build passed. The first four test workspaces passed. The final workspace's local HTTP fixtures timed out under the sandbox, so that run was interrupted |
| Local HTTP listen probe | Returned `EPERM` for `127.0.0.1`, establishing the sandbox restriction |
| `env -u RUN_INTEGRATION_TESTS yarn workspace @sig-net/midnight-examples-erc20-vault-integration-tests test` | Passed with localhost access enabled. Live-stack tests remained disabled |
| Final `yarn format:check` and `git diff --check` | Passed |

| Workspace | Tests passed | Tests skipped |
| --- | ---: | ---: |
| Vault contract | 236 | 0 |
| Shared lib | 24 | 0 |
| Vault deploy | 60 | 4 |
| Test harness | 83 | 0 |
| Integration-tests package, offline run | 50 | 109 |
| **Total** | **453** | **113** |

The regenerated compiler metadata contains **30 ledger fields**. A source census confirms **27 exported non-pure circuits**. Metadata contains 41 circuit entries including pure helpers, so do not present 41 as the callable transaction-circuit count. The compiler metadata reports version `0.33.0`. The toolchain release pin remains `0.33.0-rc.2`.

| Ledger field | Zero-based source ordinal | Compiled tree path |
| --- | ---: | --- |
| `signBidirectionalEventMap` | 0 | `[0, 0]` |
| `depositEventMap` | 18 | `[1, 3]` |
| `swapEventMap` | 22 | `[1, 7]` |
| `supplyEventMap` | 26 | `[1, 11]` |
| `redeemEventMap` | 28 | `[1, 13]` |

The existing ledger-path tests passed against these regenerated fields. Local logs are `/tmp/docs-t01-install.log`, `/tmp/docs-t01-compile.log`, `/tmp/docs-t01-test.log` and `/tmp/docs-t01-integration-offline.log`. These logs are session evidence and may be removed by the operating system. The results above are the durable summary. No live deployment, proving-key generation, manifest change, commit or push was performed.

### T02: height-model decision

**Decision:** describe the vault's implemented queue, stamp, send and settlement stages explicitly. Do not claim equivalence to the guide's immediate watermark updates or to the protocol's ordered inbox guarantees. The two replay cases below require implementation work outside this documentation task.

Reference scope: the integration guide at `3d28dc74834ea0b4ff3786e6680d5598ae08376b`, and protocol sections 4.1 and 4.2 in [bidirectional_calls.md](/Users/bernard/Projects/github.com/sig-net/mpc-bidirectional-spec/doc/bidirectional_calls.md) at `a960a7b294fb8c7f764b095d908267a2c6c65e3e`. Section 4.2 is essential context: it permits separating enqueueing from processing, but requires a total processed order in which the outstanding-request and height invariants hold. Queueing alone does not establish those guarantees.

| Concern | Guide / protocol | Observed vault behaviour and documentation consequence |
| --- | --- | --- |
| Initial height | Basic model starts at zero. The specification discusses the trade-off of an operator-supplied start height | `initialise` accepts a deployer-supplied `evmHeight`. Existing simulator tests establish that it becomes `lastSeenEvmHeight`. Source inspection of deploy tooling shows explicit `EVM_START_HEIGHT`, otherwise RPC block height, otherwise zero without an RPC. Describe it as a configured floor with an operator/RPC trust assumption, not a height authenticated by an accepted response |
| Request snapshot | Basic guide snapshots when creating the request. Protocol inbox model snapshots at processing | `flush` stamps pending work. `send*` later copies that stamp into the settle view. The snapshot can precede request publication. The interval matters to duplicate-request handling, as H02 demonstrates |
| Acceptance | Authenticate the response and require height strictly above the request's snapshot | Existing tests establish rejection at the snapshot and acceptance above it. Every settlement must describe this request-specific gate |
| Watermark advance | Basic guide advances the maximum during acceptance. Inbox model preserves the required ordering through processing | Settlement inserts into `seenEvmHeights`. A later `flush` folds only the supplied entries into `lastSeenEvmHeight`. Omitted entries remain pending. The circuit does not require all settled heights to be folded before stamping |
| Helper behaviour | On-chain invariants must hold for any caller | `flushPending` selects at most 20 settled IDs and 20 queued keys. `flushUntilStamped` returns an existing stamp immediately. A helper's usual selection does not prevent a caller from choosing a different `seen` vector |

A configured floor that is too high rejects responses at or below that floor. A zero floor has the bootstrap limitations described by the protocol. The deploy tooling's choice is therefore an operational and protocol-design decision. This audit records the difference and does not silently change the contract's initialisation policy.

**Executed out-of-order example:** initialise at 100 and publish deposit requests A and B with snapshots of 100. Settle B at height 120, then fold its height so the shared watermark becomes 120. Settle A at height 110. A succeeds against its own snapshot of 100. Folding A's height leaves the shared watermark at 120. This simulator scenario passed.

#### H01: omitted settled height permits deposit-attestation replay

Reproduced with the generated contract and a real test-key signature:

1. Initialise at 100, issue deposit A and accept its attestation at 150.
2. The request is removed and `seenEvmHeights[A]` becomes 150, while the watermark remains 100.
3. Queue the identical deposit again. Flush its key with an empty `seen` vector and send it, producing the same request ID and a snapshot of 100.
4. Submit the same attestation again with a different mint nonce. The simulator accepts settlement again, removes the request and produces shielded output.

**Required implementation follow-up:** enforce height-processing and request-admission invariants on-chain, including omitted and backlogged settled entries. The existing replay test folds A's settled height before reissuing and therefore covers only that guarded sequence. A rule telling callers to flush honestly is insufficient for a permissionless circuit.

#### H02: a deposit stamped before settlement can replay after the watermark advances

Reproduced independently of H01:

1. Publish deposit A at snapshot 100. While A remains outstanding, queue and stamp the identical deposit again. Its second stamp is also 100.
2. Accept A's attestation at 150 and fold that settled height. The shared watermark becomes 150, but the second stamp remains 100.
3. Send the already-stamped deposit after the first request has been removed. The same request ID is admitted again with the older snapshot.
4. Submit the same height-150 attestation with another mint nonce. The simulator accepts the second settlement.

**Required implementation follow-up:** define request admission across queue, stamp and send so duplicate execution identities cannot retain an earlier threshold and become fresh outstanding requests after settlement. Fixing only omission of the `seen` vector does not address this case. Preserve valid out-of-order responses while fixing both cases.

These are simulator results, not a live-chain exploit demonstration. No economic loss was attempted. The three additional audit scenarios passed as descriptions of the observed behaviour. Run them with expected rejection after an implementation fix, keeping the legitimate out-of-order scenario successful.

**Reproduction hand-off:** use the existing helpers in `examples/erc20-vault/contract/tests/erc20-vault.test.ts`, particularly `depositRequested`, `queueDeposit`, `deposit`, `flushOne`, `respond` and `padKeys`. The full temporary fixture is preserved for this session at `/tmp/docs-t02-height-reproduction.test.ts`, with results in `/tmp/docs-t02-height.log`. It was run as an ignored `tests/height-scratch.test.ts` using `yarn workspace @sig-net/midnight-examples-erc20-vault-contract test tests/height-scratch.test.ts -t 'T02 audit'`, then removed from the repository. The exact three added test bodies are preserved at the end of this checklist so the hand-off survives temporary-file cleanup.

### Review of T33 → T03 → T04

One subagent executed this dependent lane sequentially with the parent's inherited model settings. It owned only the repository instructions, diagram guide and flow-page guide. The coordinating agent read the complete diff, checked local links, verified concrete family names against the Compact exports and checked the reference guide's five numbered steps.

The first review requested clearer treatment of applicable refund variants and a consistent exception to bold/verbatim-name rules. The subagent corrected both, and the coordinating agent inspected those corrections. The final rules distinguish grouped actor-map rows, expanded concrete flow rows, unchanged copied state cells and the `n-read` exception. They also remove the fixed sanctioned canvas size and preserve paired page/Mermaid steps.

**Assessment:** accepted for T33, T03 and T04. Verification covered source/manifests/XML searches, link targets, punctuation and whitespace. No diagrams were edited, rendered or visually approved under these tasks. The fixed-version policy still conflicts with existing manifest caret ranges. T33 records that unresolved dependency-policy choice without changing manifests or treating those ranges as approved exceptions.

### Improvements to subsequent agent hand-offs

- State the exact owned files, checkout path, task IDs, prerequisites and exclusions. Reserve checklist updates for the coordinating agent.
- Include the current T01 dependency and compiler baseline. Distinguish an environment failure, such as localhost `EPERM`, from a failed implementation assertion.
- Include this T02 decision and both H01/H02 reproductions with every height, queue, setup or settlement task. Require a clear distinction between current behaviour and unresolved guarantees. Safety claims remain blocked until implementation work and regression tests resolve them.
- For flow-page tasks, require a transaction-boundary list and compare canonical headlines, Mermaid notes and diagram ordinals. Check the actual source calls, including permissionless flush/send and any refund branch.
- For diagram tasks, name the exact XML/PNG pair and the actor-map revision or content hash being copied. Specify permitted curated-cell changes and enumerate concrete rows expanded from grouped operations. Verify unchanged-cell equality, expanded source names/styles and `n-read` membership separately. Require render output and visual inspection evidence.
- Require a short completion report with changed files, exact verification results, unresolved questions and any hand-off gaps. The coordinating agent reviews the diff and evidence before marking a task complete.

## Stage 2 progress: T05 (27 September 2026)

**T05 completed and reviewed.** One subagent wrote the Compact queue/height comments. A second subagent independently checked the constructors, consumers and final diff. Both inherited the coordinating agent's model settings. The coordinating agent reviewed the changes and applied the reviewer's clarification that supply/redeem sends use ledger `stataToken` and `vaultEvmAddress` directly.

The change adds 48 comment lines in [erc20-vault.compact](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact). It covers all seven pending-payload variants, queue/stamp lifetimes, flush-to-send nonce reservations, request-specific height thresholds and partial/full batch rules. The comments explicitly distinguish caller-selected settled heights from the completeness requirement for a partial queue batch. H01 and H02 remain open implementation defects.

Verification:

- Executable-token comparison with the saved pre-edit source passed. An in-memory declaration-name mutation failed that comparison, confirming the check detects a code change. Signatures, field order and circuit behaviour are unchanged.
- Independent source census found seven queue constructors, seven send entry points, nine settlement-height consumers and five stamp-to-settle-view copies.
- A targeted simulator experiment queued a withdrawal under the all-zero key and flushed with both vectors produced by `padKeys([])`. The real zero key was stamped, the pending payload remained, `unflushed` became zero and nonce zero was reserved. The test passed. This verifies that zero padding follows ordinary membership checks, rather than being an unconditional sentinel.
- Compile, root formatting, root lint, contract typecheck and all **236 contract tests** passed. The additional zero-key experiment passed separately. Temporary audit test files were removed from the repository.
- `git diff --check` and added-comment punctuation checks passed. Existing history-marker searches in the Compact file returned no matches.

Session logs are `/tmp/docs-t05-compile.log`, `/tmp/docs-t05-format.log`, `/tmp/docs-t05-lint.log`, `/tmp/docs-t05-build.log`, `/tmp/docs-t05-test.log` and `/tmp/docs-t05-zero-key.log`. The temporary zero-key fixture is preserved at `/tmp/docs-t05-zero-key-reproduction.test.ts`. The observed sequence above remains the reproduction description if temporary files are cleaned up.

**Review assessment:** accepted. No behavioural changes, new replay guarantees or edits outside T05's comment scope were introduced. The independent review improved one address-consumer description before completion.

**Hand-off improvements:** require a field-to-constructor/consumer table for shared payloads. Label circuit invariants, helper conventions and unresolved guarantees separately. Treat map padding as a membership question, and verify stored fields against the fields actually read by send circuits. For comment-only tasks, require an executable-token comparison as well as compiler and test evidence. The next planned task is T06, using the reviewed T05 comments as its baseline.

## Agent-sized task list

Each checkbox below is one dispatchable task with one page, one substantial section, one diagram source/render pair or one evidence report as its deliverable. The D identifiers below remain audit finding references, not work items. Task identifiers are T01–T35.

For each task, use its deliverable, context locations and cited findings as the agent prompt. Change only the named scope, verify claims against the current implementation, and record evidence. Track implementation defects separately. Do not commit or push without an explicit instruction.

**Order:** resolve validation and height semantics first. Write the generic vault flow and admin/configuration sections before the individual walkthroughs. Complete the actor map before adapting its state cells and operation styles for flow diagrams. Tasks sharing the vault README or Compact file should run sequentially. Each page and its diagram have separate tasks, and their paired updates must both be complete before the documentation is considered ready.

- [x] **T01. Restore the audit validation environment** (P1)
  **Deliverable:** the validation-results section of this checklist. Restore the committed dependency versions, compile and run the existing offline checks. Record the current circuit count, ledger indices and results here. Keep manifests unchanged and generated files uncommitted.
  **Context:** [root manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/package.json), [lockfile](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/yarn.lock), [contract manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/package.json). **Findings:** Validation limitation. **After:** None.

- [x] **T02. Resolve the vault height-model documentation question** (P1)
  **Deliverable:** a height-model decision note in this checklist. Compare initial height, flush-time snapshots and deferred watermark updates with the guide. Record supported explanations and any unresolved implementation issue. Supply a concrete out-of-order response example for subsequent writing tasks.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact) (`initialise`, `settleHeight`, `flush`), [initialisation tooling](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts), [updated integrator guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md). **Findings:** D03, D04. **After:** T01.

- [x] **T03. Clarify the diagram style guide** (P2)
  **Deliverable:** [docs/diagramming.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagramming.md). Encode the actor-map scope decision above: exported state plus one grouped line per operation, with concrete circuit rows permitted in flow diagrams. Define the grouped-label exception and style reuse without requiring identical grouped and expanded labels. Resolve the n-read membership exception, remove brittle sanctioned-size claims, and define any necessary queue/flush label vocabulary. Correct the identified prose punctuation while preserving technical style strings.
  **Context:** [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [palette](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagram-palette.drawio). **Findings:** D13, D28, D30. **After:** T33.

- [x] **T04. Clarify the flow-page style guide** (P3)
  **Deliverable:** [docs/flow-pages.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/flow-pages.md). Correct the upstream reference heading and state how a request phase describes queue, flush and send. Preserve the paired canonical headlines and Mermaid notes, including shared ordinals for settlement branches.
  **Context:** [updated integrator guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md), [diagram guide](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagramming.md). **Findings:** D01, D13, D30. **After:** T03.

- [x] **T05. Document Compact queue and height invariants** (P1)
  **Deliverable:** comments in the ledger and queue/height sections of [erc20-vault.compact](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact). Document PendingVaultRequest field meanings, stamps, nonce ownership, batch limits, partial-flush completeness and height propagation at their definitions. Keep circuit behaviour unchanged.
  **Context:** [queue helpers](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/vault-queue.ts), [contract tests](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/tests/erc20-vault.test.ts). **Findings:** D03, D04, D11, D27. **After:** T02.

- [ ] **T06. Correct Compact setup, admin and hash comments** (P2)
  **Deliverable:** header, configuration and hash-helper comments in [erc20-vault.compact](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact). Correct MPC versus relayer roles, binder purpose and finite allowance wording. Explain admin preconditions and hash-fork consequences at the relevant definitions. Preserve technical punctuation and circuit behaviour.
  **Context:** [initialisation tooling](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts), [admin replacement test](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/tests/admin-replace-nonce-e2e.test.ts). **Findings:** D06, D10, D12, D26, D28. **After:** T02.

- [ ] **T07. Correct Compact flow-circuit comments** (P2)
  **Deliverable:** flow and settlement comments in [erc20-vault.compact](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact). Describe burns and queueing on start circuits, publication on send circuits and the actual settlement gates. Move comments off unrelated structs, correct refund binders and narrow unsupported return/privacy claims. Remove the two identified prose semicolons without altering code.
  **Context:** [flow implementations](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows), [contract tests](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/tests/erc20-vault.test.ts). **Findings:** D01, D05, D25–D29. **After:** T05, T06.

- [ ] **T08. Update the repository README** (P1)
  **Deliverable:** [root README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/README.md). Correct the protocol link and V1 terminology, include application height state in the integration summary, and distinguish offline tests from simulator tests. Keep this page at repository/protocol level and link to the vault-specific overview.
  **Context:** [updated integrator guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md), [root scripts](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/package.json). **Findings:** D07, D15, D16, D31. **After:** T02, T10.

- [ ] **T09. Update the vault README introduction and inventory** (P2)
  **Deliverable:** The vault’s circuits, The actors, The flows and Package layout sections of [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). List the verified current circuit surface by role, correct actor counts and excerpt promises, and distinguish browser-safe exports from the Node asset CLI. Link to the generic flow and administration sections.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [curated exports](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/index.ts), [package manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/package.json). **Findings:** D01, D13, D31. **After:** T01, T10, T14.

- [ ] **T10. Add the generic vault-flow overview** (P1)
  **Deliverable:** a Generic vault flow section in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Explain the shared queue → flush → send → sign → broadcast → attest → settle lifecycle before the individual walkthroughs. Identify actors, state transitions, transaction boundaries, permissionless actions, nonce and height assignment, and the deposit/approval exceptions. Include one generic Mermaid sequence and links to all five walkthroughs.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [queue helpers](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/vault-queue.ts), [flow implementations](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows). **Findings:** D01–D03, D05–D07, D11, D25. **After:** T02, T05.

- [ ] **T11. Rewrite the vault derived-key section** (P1)
  **Deliverable:** Derived keys and accounts in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Use the padded-byte hex path and complete derivation domain, distinguish request and response paths, and explain the pinned key version. Correct the response-event field description and verify the account derivation example.
  **Context:** [vault derivation helper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/index.ts), [integration guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md). **Findings:** D06–D08. **After:** T01.

- [ ] **T12. Update vault setup steps 1 to 3** (P1)
  **Deliverable:** Setup steps 1 to 3 in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Align dependencies and compile instructions with the pinned packages. Correct the ledger explanation and compiler-verified map paths, and include queue and height state. Keep snippets minimal and executable.
  **Context:** [contract manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/package.json), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [ledger-path tests](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/tests/ledger-paths.test.ts). **Findings:** D03, D09, D14. **After:** T01, T02.

- [ ] **T13. Update vault setup step 4 and runtime joining** (P1)
  **Deliverable:** Setup step 4 and Runtime: joining the deployed vault in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Correct the raw vault path, include responseKeyVersion and evmHeight, and show the actual private-state/joining contract. Link to the generic lifecycle and admin configuration ownership without repeating their explanations.
  **Context:** [initialisation tooling](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts), [vault derivation helper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/index.ts), [vault context](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/vault-context.ts). **Findings:** D04, D06, D08, D22. **After:** T02, T11, T14.

- [ ] **T14. Add the admin and configuration section** (P1)
  **Deliverable:** an Admin and configuration section in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Explain the deployer identity and maintenance authority separately. Describe one-shot configuration, pinned addresses/key version/height, mutable gas settings and when sends read them. Document issued versus reserved nonces, replacement preconditions, the self-transfer request and subsequent unviable/refund handling. Use a compact configuration table.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact) (`initialise`, `setGasParams`, `adminReplaceEvmNonce`), [deploy configuration](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts), [EVM targets](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/evm-targets.ts). **Findings:** D04, D06, D10, D12, D22, D23. **After:** T02, T06.

- [ ] **T15. Fix the local-running section** (P2)
  **Deliverable:** Running it and its local setup instructions in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Remove duplicate fresh-clone zk compilation, separate e2e setup from standalone deployment, and explain recovery after skip-zk compilation removes keys. Verify quoted local commands and qualify unmeasured duration claims.
  **Context:** [compile setup helper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/steps.ts), [example setup](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/setup.ts), [compose configuration](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docker-compose.yaml). **Findings:** D17, D24. **After:** T01.

- [ ] **T16. Fix the remote-network running sections** (P2)
  **Deliverable:** real Sepolia, real MPC and step-through sections in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Replace the missing minimal-env link with the existing example, describe SDK-resolved network values and cache URLs, and retain the actual per-flow tracing limitations. Verify network availability claims, manual funding and supported suite scope. Correct the identified prose punctuation.
  **Context:** [environment example](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/.env.example), [example setup](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/setup.ts), [output-source handling](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/output-source.ts). **Findings:** D15, D23, D24, D28. **After:** T14.

- [ ] **T17. Update the vault deployment section** (P2)
  **Deliverable:** Deploying, maintenance-key and CI deployment sections in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Correct the circuit count, distinguish the one-shot circuit from its rerun-safe wrapper, and verify split-deploy/resume instructions against the entrypoints. Link to the admin section for configuration and authority semantics.
  **Context:** [deploy flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/deploy-vault.ts), [initialisation wrapper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts), [deploy workflow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/.github/workflows/erc20-vault-deploy.yml). **Findings:** D13, D22. **After:** T01, T14.

- [ ] **T18. Update the e2e suite and benchmark reference** (P2)
  **Deliverable:** The e2e suite inventory and benchmark descriptions in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Collect the current tests, correct counts and order, list offline coverage, and distinguish per-circuit proof metrics from orchestration timings. Explain the queue benchmark’s distinct approval tokens and qualify unmeasured suite duration/memory figures.
  **Context:** [test order](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/vitest.config.ts), [test sources](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/tests). **Findings:** D18, D19, D24. **After:** T01.

- [ ] **T19. Rewrite the test-run recovery section** (P1)
  **Deliverable:** Test run recovery in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Document automatic recycling and its override. Replace the no-request-id/no-resume assumption with verified recovery for queued, stamped and sent requests. State any tooling gap explicitly. Verify responder restart/backfill claims and distinguish resource observations from guarantees.
  **Context:** [proof-server hooks](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/flow-hooks.ts), [start flows](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows), [queue helpers](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/vault-queue.ts). **Findings:** D20, D21, D24. **After:** T10, T14, T15.

- [ ] **T20. Update the release and zk-assets section** (P2)
  **Deliverable:** Releasing to npm and its subsections in [vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). Correct circuit counts, verify package contents and regeneration instructions, and replace unsupported size/key-generation figures with measured or clearly qualified values. Preserve manifest integrity requirements. Validate locally without publishing or tagging.
  **Context:** [manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/package.json), [publish workflow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/.github/workflows/erc20-vault-publish.yml), [asset tooling](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/zk-assets/run.ts). **Findings:** D13, D24. **After:** T01.

- [ ] **T21. Update the deposit walkthrough** (P1)
  **Deliverable:** [deposit.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/deposit/deposit.md). Show startDeposit, flush and sendDeposit before signing, with the caller account’s nonce and the pinned MPC key version. Correct settlement timing, height checks, event conversion and source anchors. Keep the depositor gate and failed-deposit behaviour accurate. Update the page’s prose and Mermaid together, keeping canonical step strings identical and checking every link. The separate diagram task owns its draw.io pair.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-deposit.ts), [settlement flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-deposit.ts), [vault overview](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). **Findings:** D01–D04, D06, D07, D13–D15, D25. **After:** T04, T10, T14.

- [ ] **T22. Update the withdraw walkthrough** (P1)
  **Deliverable:** [withdraw.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/withdraw/withdraw.md). Show queue, flush and sendWithdraw, assigned vault nonce and queue-key refund commitment. Correct gas administration, settlement ownership, height checks, event conversion and source anchors. Preserve the executed true/false and failed/unviable branches. Update the page’s prose and Mermaid together, keeping canonical step strings identical and checking every link. The separate diagram task owns its draw.io pair.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-withdraw.ts), [settlement flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-withdraw.ts), [vault overview](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). **Findings:** D01–D07, D10, D13–D15, D25. **After:** T04, T10, T14.

- [ ] **T23. Update the swap walkthrough** (P1)
  **Deliverable:** [swap.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/swap/swap.md). Show the approval and swap queue/flush/send paths. Correct request-id semantics, refund binder, gas configuration and finite allowance behaviour. Explain attested-height checks and output conversion, narrow asset/privacy claims, and repair source anchors. Update the page’s prose and Mermaid together, keeping canonical step strings identical and checking every link. The separate diagram task owns its draw.io pair.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-swap.ts), [settlement flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-swap.ts), [vault overview](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). **Findings:** D01–D07, D10, D13–D15, D25, D29. **After:** T04, T10, T14.

- [ ] **T24. Update the supply walkthrough** (P1)
  **Deliverable:** [supply.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/supply/supply.md). Show the approval and supply queue/flush/send paths. Correct nonce allocation, queue-key refund binding, gas/allowance claims and ledger references. Link the shared attestation poll, explain height checks and conversion, and accurately describe outgoing underlying and incoming shares. Update the page’s prose and Mermaid together, keeping canonical step strings identical and checking every link. The separate diagram task owns its draw.io pair.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-supply.ts), [settlement flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-supply.ts), [vault overview](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). **Findings:** D01–D07, D10, D13–D15, D25, D29. **After:** T04, T10, T14.

- [ ] **T25. Update the redeem walkthrough** (P1)
  **Deliverable:** [redeem.md](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/redeem/redeem.md). Show queue, flush and sendRedeem. Correct nonce allocation, refund binding, gas configuration and ledger references. Link the shared poll, explain height checks and event conversion, and remove the unenforced minimum-principal guarantee. Update the page’s prose and Mermaid together, keeping canonical step strings identical and checking every link. The separate diagram task owns its draw.io pair.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-redeem.ts), [settlement flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-redeem.ts), [vault overview](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md). **Findings:** D01–D07, D10, D13–D15, D25, D29. **After:** T04, T10, T14.

- [ ] **T26. Update the vault actor map** (P2)
  **Deliverable:** [actor-map.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio) and its adjacent PNG. Census the current exported ledger state and represent it with one grouped circuit line per operation: deposit, withdraw, swap, supply and redeem. Use compact labels such as `start/send/completeDeposit(...)`, checking each group against actual source names and including applicable settlement/refund variants. Keep actors and relationships, omit the separate witness inventory, and leave the complete circuit inventory to the README. Preserve curated cells outside the affected layout, update derivation labels, render the PNG and inspect readability. Establish the state cells and visual styles reused by flow diagrams.
  **Context:** [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [vault inventory](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md), [diagram guide](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagramming.md). **Findings:** D08, D13. **After:** T03, T09, T11.

- [ ] **T27. Update the deposit flow diagram** (P2)
  **Deliverable:** [deposit.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/deposit/deposit.drawio) and its adjacent PNG. Reuse the actor map’s relevant state cells and visual styles. Expand its grouped operation line into only the concrete circuit rows this flow uses, verifying their names against source. Grouped actor-map labels need not be copied verbatim. Draw the page’s queue/flush/send sequence with matching numbered circles, correct request/response names and attached orthogonal edges. Respect curation, render the paired PNG and inspect it at reading size.
  **Context:** [flow page](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/deposit/deposit.md), [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-deposit.ts). **Findings:** D01, D08, D13. **After:** T26, T21.

- [ ] **T28. Update the withdraw flow diagram** (P2)
  **Deliverable:** [withdraw.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/withdraw/withdraw.drawio) and its adjacent PNG. Reuse the actor map’s relevant state cells and visual styles. Expand its grouped operation line into only the concrete circuit rows this flow uses, verifying their names against source. Grouped actor-map labels need not be copied verbatim. Draw the page’s queue/flush/send sequence with matching numbered circles, correct request/response names and attached orthogonal edges. Respect curation, render the paired PNG and inspect it at reading size.
  **Context:** [flow page](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/withdraw/withdraw.md), [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-withdraw.ts). **Findings:** D01, D08, D13. **After:** T26, T22.

- [ ] **T29. Update the swap flow diagram** (P2)
  **Deliverable:** [swap.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/swap/swap.drawio) and its adjacent PNG. Reuse the actor map’s relevant state cells and visual styles. Expand its grouped operation line into only the concrete circuit rows this flow uses, verifying their names against source. Grouped actor-map labels need not be copied verbatim. Draw the page’s queue/flush/send sequence with matching numbered circles, correct request/response names and attached orthogonal edges. Respect curation, render the paired PNG and inspect it at reading size.
  **Context:** [flow page](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/swap/swap.md), [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-swap.ts). **Findings:** D01, D08, D13. **After:** T26, T23.

- [ ] **T30. Update the supply flow diagram** (P2)
  **Deliverable:** [supply.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/supply/supply.drawio) and its adjacent PNG. Reuse the actor map’s relevant state cells and visual styles. Expand its grouped operation line into only the concrete circuit rows this flow uses, verifying their names against source. Grouped actor-map labels need not be copied verbatim. Draw the page’s queue/flush/send sequence with matching numbered circles, correct request/response names and attached orthogonal edges. Respect curation, render the paired PNG and inspect it at reading size.
  **Context:** [flow page](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/supply/supply.md), [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-supply.ts). **Findings:** D01, D08, D13. **After:** T26, T24.

- [ ] **T31. Update the redeem flow diagram** (P2)
  **Deliverable:** [redeem.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/redeem/redeem.drawio) and its adjacent PNG. Reuse the actor map’s relevant state cells and visual styles. Expand its grouped operation line into only the concrete circuit rows this flow uses, verifying their names against source. Grouped actor-map labels need not be copied verbatim. Draw the page’s queue/flush/send sequence with matching numbered circles, correct request/response names and attached orthogonal edges. Respect curation, render the paired PNG and inspect it at reading size.
  **Context:** [flow page](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/redeem/redeem.md), [actor map](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact), [start flow](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-redeem.ts). **Findings:** D01, D08, D13. **After:** T26, T25.

- [ ] **T32. Update the generic protocol diagram** (P2)
  **Deliverable:** [sign-bidirectional-flow.drawio](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/sign-bidirectional-flow.drawio) and its adjacent PNG. Reconcile concrete event/map labels with the V1 protocol and verify key-derivation and attestation descriptions. Keep the hypothetical startCrossChain/completeCrossChain placeholders and protocol-level scope. Preserve curation, render and inspect the PNG.
  **Context:** [updated protocol guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md), [root README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/README.md), [diagram guide](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagramming.md). **Findings:** D07, D13. XML inspection also found unversioned concrete event labels. **After:** T03, T08.

- [x] **T33. Reconcile repository instruction contradictions** (P3)
  **Deliverable:** the repository AGENTS.md, edited by the agent. Replace the full-anatomy actor-map rule with the requested state-plus-grouped-operations scope. Permit grouped actor-map labels and concrete flow-diagram rows without requiring byte-identical labels. Correct the identity-rule count and explicitly reconcile fixed-version and test-dependency rules with manifests. Preserve the justified two-TypeScript arrangement. Record any policy choice requiring user direction instead of silently changing dependency policy.
  **Context:** [workspace manifests](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault), [root manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/package.json). **Findings:** D32. **After:** None.

- [ ] **T34. Update the agent e2e operational instructions** (P2)
  **Deliverable:** the agent-maintained .claude/skills/e2e/SKILL.md. Bring compile cadence, suite counts/order, cache configuration, automatic recycling and interrupted-queue recovery into agreement with the completed README tasks. Keep it agent-facing and avoid copying unsupported timings or responder guarantees.
  **Context:** [verified operational sections](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md), [setup helper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/steps.ts), [proof-server hooks](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/flow-hooks.ts). **Findings:** D17–D24, D32. **After:** T15, T16, T18, T19.

- [ ] **T35. Run the final documentation consistency audit** (P2)
  **Deliverable:** a completion report in this checklist. Check local links, source names, step-list/Mermaid correspondence and diagram membership across the completed deliverables. Confirm each diagram task recorded a render inspection and each copyable example has executed evidence. Record remaining issues and existing check results without turning this into another multi-file editing task.
  **Context:** [root README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/README.md), [vault documentation](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs), [contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact). **Findings:** Final validation. **After:** All applicable writing and diagram tasks.

## Audit scope and evidence

The tracked-file inventory and a second scan including hidden and ignored files found the same **12 maintained Markdown files and one handwritten Compact file**. Dependency trees, generated `managed/` output and `dist/` output are excluded from the editing scope. Generated output was stale during the initial audit. T01 regenerated and validated it, as recorded above.

| File | Coverage and relevant findings |
| --- | --- |
| `README.md` | Protocol summary, setup, package scripts, prerequisites and links. D07, D15, D16, D31 |
| `examples/erc20-vault/README.md` | All sections, including snippets, deployment, e2e operations and publishing. D01–D13, D15–D24, D28, D31 |
| `examples/erc20-vault/docs/deposit/deposit.md` | Full prose, links and Mermaid. D01, D03, D04, D06, D07, D13–D15, D25 |
| `examples/erc20-vault/docs/withdraw/withdraw.md` | Full prose, links and Mermaid. D01–D07, D13–D15, D25 |
| `examples/erc20-vault/docs/swap/swap.md` | Full prose, links and Mermaid. D01–D07, D10, D13–D15, D25, D29 |
| `examples/erc20-vault/docs/supply/supply.md` | Full prose, links and Mermaid. D01–D07, D10, D13–D15, D25, D29 |
| `examples/erc20-vault/docs/redeem/redeem.md` | Full prose, links and Mermaid. D01–D07, D13–D15, D25, D29 |
| `examples/erc20-vault/contract/src/erc20-vault.compact` | Entire contract, comments, signatures, state transitions and hash sites. D01–D12, D26–D29 |
| `docs/flow-pages.md` | Complete guide. D13, D30 |
| `docs/diagramming.md` | Complete guide. D13, D28, D30 |
| `AGENTS.md` | Rules checked against manifests and repository structure. D32 |
| `CLAUDE.md` | Single reference to `AGENTS.md`, which exists. No independent defect found |
| `.claude/skills/e2e/SKILL.md` | Operational instructions checked as audit data. Agent maintenance under D17–D24, D32 |

Evidence gathered:

- Executed file, symbol, call-site, link-target, heading, line-anchor, circuit, ledger and test-declaration scans.
- Compared all five flow step lists with their Mermaid notes. Each pair agrees today, but both describe the outdated lifecycle.
- Parsed actor-map XML and compared its labels with current exported Compact members.
- Executed the installed SDK's account derivation with a public test key. The literal `vault` and hex-encoded, 32-byte-padded `vault` produced different addresses.
- Compared manifests, workflows, setup functions and the updated local integration guide. Remote URL availability, live networks, publishing and diagram appearance were not tested.

### Initial audit validation (26 September, superseded by T01)

The following records the initial audit environment. Use the Stage 1 results above for the restored environment.

The installed `@sig-net/midnight`, `@sig-net/midnight-contract` and deploy package report **0.24.0-rc.2**, while committed manifests require **0.24.0-rc.4**. The existing generated ledger has 27 fields. The current source declares 30. Do not use that generated output to establish the current contract's layout or behaviour.

| Executed check | Observed result |
| --- | --- |
| `yarn compile` | Failed on the unbound `constructSignBidirectionalEventV1` identifier |
| `yarn format:check && yarn lint && yarn build && yarn test` | Formatting passed. Lint stopped the chain with three type-related errors in queue code and contract tests |
| `yarn build` | Failed against stale generated signatures and missing ledger members |
| `yarn test` | Contract workspace reported 179 failures and 57 passes. The workspace runner then stopped |

These results do **not** establish defects in the committed contract. They establish that this checkout cannot currently validate it. No dependency installation, deployment, commit or push was performed.

## Audit findings: integration model

### D01. Describe queue, flush and send separately in every flow.
  **Locations:** vault README circuit table and integration walkthrough, all five flow pages, Compact comments above `startWithdraw`, `startSwap`, `SupplyRequest` and `RedeemRequest`.
  **Evidence:** every `start-*.ts` flow calls its `start*` circuit, `flushUntilStamped`, then its `send*` circuit. The Compact `start*` circuits insert `pendingVaultRequests`, while `send*` creates the protocol record, settle view and singleton notification. Approval flows also queue, flush and send.
  **Done when:** prose distinguishes the TypeScript orchestration function from the same-named Compact circuit, shows the required calls in order and removes the claims that a normal round trip needs only two Midnight transactions. A normal request also needs a flush and a send, with additional flush attempts possible under contention.

### D02. Explain nonce allocation and the public queue keys.
  **Locations:** request steps in withdraw, swap, supply and redeem, approval steps, vault README runtime section.
  **Evidence:** those start-flow option types do not accept an EVM nonce. `stampIfUnstamped` allocates vault nonces from `vaultEvmNonce`. Deposits retain the caller account's supplied nonce and receive only a height stamp. `newQueueKey` supplies the burn flows' keys. `approveRouterBinder` and `approveStataBinder` supply public approval keys.
  **Done when:** remove each claim that the caller supplies the vault's next EVM nonce. Explain who may queue, flush and send, how duplicate pending approval keys are rejected, and why deposits do not consume a vault nonce.

### D03. Add the attested-height acceptance rule to every settlement description.
  **Locations:** all five flow pages, vault README protocol and ledger sections, `settleHeight` and `flush` comments.
  **Evidence:** `settleHeight` requires `blockHeight > view.knownHeight` and records the accepted height in `seenEvmHeights`. `flush` folds supplied settled heights into `lastSeenEvmHeight` before stamping new requests. The Markdown search found no explanation of `knownHeight`, `seenEvmHeights` or `lastSeenEvmHeight`.
  **Done when:** describe strict comparison with the request's snapshot, successful and failed settlement, out-of-order responses, the maximum-height update and atomic rollback. Signature validity alone is insufficient for settlement. Include an example in which a later response arrives first without invalidating an earlier request's acceptable response.

### D04. Resolve and document the differences from the updated integrator guide's height model.
  **Locations:** vault README setup and runtime, Compact initialisation and flush documentation.
  **Evidence:** the guide initialises its watermark to zero, snapshots at request creation and advances the watermark during settlement. The vault accepts an initial `evmHeight`, snapshots during flush and advances the shared watermark later from the caller-supplied `seen` list. Deploy tooling uses `EVM_START_HEIGHT`, otherwise the RPC's latest block, otherwise zero when no RPC is configured.
  **Done when:** explicitly explain the vault's chosen model and its trust assumptions, including omitted or backlogged `seen` entries and stamping before request publication. Confirm these differences satisfy the intended protocol requirement before claiming equivalence. If they do not, record a separate implementation task instead of documenting the intended behaviour as already implemented.

### D05. Correct what refund commitments bind to.
  **Locations:** withdraw, swap, supply and redeem request steps.
  **Evidence:** all four pages say `refundCommitment` binds the caller's secret and request id. The contract computes it from the caller's secret and queue `key`, stores that key in the settle view, and checks `refundCommitment(callerSecretKey(), view.key)` at settlement.
  **Done when:** distinguish queue key, protocol request id and mint nonce. Attribute settle-view insertion to `send*`, and explain the requester gate without claiming the request id is its binder.

### D06. Document the pinned MPC key version.
  **Locations:** deposit request step, vault README initialisation snippet and derived-key section.
  **Evidence:** `initialise` takes `responseKeyVersion` and stores `mpcKeyVersion`. Request constructors use that ledger value. `startDeposit` does not accept a key version, although the page says the caller chooses one. The initialisation snippet omits both the version and `evmHeight` arguments.
  **Done when:** show the current initialisation contract, including both omitted inputs, and explain that the response key and request signing key version are configured together. Check the TypeScript expected-record builders separately, since several use `SIGNET_DEFAULT_KEY_VERSION` rather than reading the ledger version.

### D07. Correct V1 request-id and attestation terminology.
  **Locations:** withdraw and swap request steps, vault README response-key table, root protocol summary, all flow pages.
  **Evidence:** withdraw and swap call the request id the record's own hash. The integration SDK's `RequestIdPreimageV1` contains key version, sender, path, algorithm, transaction parameter type, transaction digest and execution destination. Schemas and reserved MPC parameters are excluded. The response-key table says the event carries only an id and signature, contradicting the event fields described on the flow pages.
  **Done when:** use the V1 execution-identity definition consistently, explain that matching an id does not compare every record field, and accurately list attestation height, kind, width, digest and signature. Keep valid unversioned TypeScript SDK aliases distinct from the concrete V1 Compact and wire types.

### D08. Fix the vault-account derivation snippet before anyone copies it.
  **Location:** vault README, Setup step 4, around line 293.
  **Evidence:** the snippet calls `deriveEvmAddress` with the raw string `vault`. The contract records `pad(32, "vault")`, and `deriveVaultEvmAddress` uses `VAULT_PATH_HEX`. The executed test-key example produced different addresses for the two representations.
  **Done when:** use the exported vault derivation helper or the exact padded-byte hex rendering. Keep the response key's literal protocol path distinct. Expand the conceptual derivation formula to account for the SDK's derivation prefix and Midnight CAIP-2 domain, as the updated guide does, without confusing it with EVM `chainId`.

### D09. Replace the stale setup dependency example.
  **Location:** vault README, Setup step 1, lines 183–191.
  **Evidence:** the example pins both Sig Network packages to `0.21.0`, while the contract manifest pins both to `0.24.0-rc.4` and the source imports V1 definitions.
  **Done when:** the example agrees with committed manifests, its compile example works with that version, and the explanation identifies the matched SDK, singleton and fakenet versions. Avoid copying the installed checkout's older version into the docs.

### D10. Explain mutable gas configuration and approval limits accurately.
  **Locations:** vault README circuit table, withdraw/supply/redeem claims that retuning requires redeployment, swap and supply approval sections, `unlimitedAllowance` comment.
  **Evidence:** `setGasParams` is deployer-gated and updates the fee caps and per-kind gas limits. Vault-signed `send*` circuits read them at send time. Deposit gas settings come from its queued request. `unlimitedAllowance` returns the finite value `2^128 - 1`, and approval helpers skip whenever current allowance is greater than zero.
  **Done when:** remove the redeployment requirement and the unconditional permanent/forever allowance claims. Explain send-time gas configuration and the helpers' nonzero-allowance criterion, which is not a check that the next requested spend is covered.

### D11. Document the complete flush contract and conflict handling.
  **Locations:** new queue explanation within the existing vault README, comments at `flush`, `stampIfUnstamped`, `takePending` and `takeStamp`.
  **Evidence:** flush accepts two 20-entry vectors, folds settled heights, stamps at most 20 waiting requests, and requires a partial batch to include every waiting request. Non-deposit stamps reserve nonce ownership. Queue helpers retry recognised ledger conflicts while preserving other failures.
  **Done when:** describe padding, batch limits, full versus partial batches, permissionless execution, retry limits and which data must be reread after a conflict. Explain the invariants once at their definitions and link to them from flows.

### D12. Add the administration and nonce-recovery surface.
  **Locations:** vault README circuit table and recovery section, Compact `adminReplaceEvmNonce` documentation.
  **Evidence:** `adminReplaceEvmNonce` rejects unissued nonces and nonces held by unsent requests, then records a 21,000-gas empty self-transfer using the vault account. `nonceOwners` is cleared by the send transition. This differs from the requester's normal queue flow.
  **Done when:** explain who can invoke it, when it is allowed, which stuck transaction it replaces, and how the displaced request reaches an attested `unviable` outcome and its applicable refund path. Explain that this admin request has no ordinary asset-settlement circuit.

## Audit findings: walkthroughs and operations

### D13. Update the complete README inventory and the scoped diagram representations.
  **Locations:** vault README actor and circuit sections, all five Mermaid sequences and their embedded diagram pairs.
  **Evidence:** source census found **27 exported non-pure circuits**. The README says seventeen in its actor section and 26 in deployment and asset sections. Actor-map XML lacks `setGasParams`, `adminReplaceEvmNonce`, `flush` and all seven `send*` circuits. It also lacks eleven exported ledger fields: both fee caps, `vaultGasLimits`, `unflushed`, `mpcKeyVersion`, both height fields, `vaultEvmNonce`, `pendingVaultRequests`, `stamps` and `nonceOwners`.
  **Done when:** the README table covers the complete current circuit surface. The actor map covers exported ledger state and one grouped circuit line per operation, following the scope decision above. Missing individual circuit rows are not defects in that overview. Flow diagrams expand the relevant operation into its actual circuit calls, and queue/flush/send calls appear in each sequence. Change canonical step headlines and Mermaid notes together. Preserve the actor map's existing curation, regenerate each affected PNG and inspect the renders. The audit checked XML membership, not visual layout.

### D14. Correct ledger counts and field ordinals without changing valid paths.
  **Locations:** vault README Setup step 3, supply and redeem request steps.
  **Evidence:** source declares 30 ledger fields. Deposit, swap, supply and redeem maps are at zero-based ordinals 18, 22, 26 and 28. The README says 20 fields and deposit at field 8, while supply and redeem say fields 16 and 18. Source notification vectors and exported constants still use `[1, 3]`, `[1, 7]`, `[1, 11]` and `[1, 13]`.
  **Done when:** verify a fresh compiler's field indices, then document the 15 + 15 grouping and correct ordinals, or omit brittle ordinals and link to the authoritative exports. Keep the correct vectors unless fresh compilation demonstrates a change.

### D15. Repair broken, misleading and obsolete links.
  **Locations:** root README and every flow page, vault README deployed-network section.
  **Confirmed targets:** the linked `.env.example-stagenet-minimal` does not exist. The protocol link fragment `#sign-bidirectional-flow` does not match the supplied guide's `#sign-bidirectional-protocol-flow`. Swap's `index.ts#L88` lands on the supply constant, supply's `#L91` lands on the redeem constant, and redeem's `#L94` exceeds the file length. `createResponseReader` links land in context construction. Approval and poll line anchors also need review.
  **Done when:** use the existing `.env.example` or add and verify the promised minimal example, correct the protocol fragment, and replace fragile line anchors with verified symbol locations or file links. Ignore the intentional `<flow>.drawio.png` placeholder in the page-style example. Remote link availability remains a separate check.

### D16. Include the height state in the root integration summary.
  **Location:** root README Integrator Guide setup list.
  **Evidence:** the summary mentions the event map, singleton reference and response key but omits the per-request height snapshot and watermark explained as application responsibilities in the updated guide.
  **Done when:** the summary names the extra application state and settlement check, and directs readers to the updated guide for the detailed protocol. Avoid presenting the three existing state elements as a sufficient implementation.

### D17. Remove duplicate proving-key generation from the fresh-clone walkthrough.
  **Location:** vault README Running it section and corresponding agent operational instructions.
  **Evidence:** the README manually generates zk assets before invoking e2e. `compileContractZk` skips only for a deployed address or trusted CI cache, so a fresh local e2e run compiles again even when keys already exist. The root README correctly says setup performs the first zk compile.
  **Done when:** publish one consistent fresh-clone sequence, distinguish standalone deploy prerequisites from e2e setup, and retain a separate recovery instruction for keys removed by a later skip-zk compile. Validate the sequence in a disposable environment before quoting new commands.

### D18. Recount the suite and correct its order.
  **Locations:** vault README e2e table and totals, agent operational instructions.
  **Evidence:** current `FILE_ORDER` runs `admin-replace-nonce-e2e` before `vault-queue-benchmark`. An anchored source scan counted 109 `it(...)` declarations across the fourteen ordered e2e files, including ten in bearer-transfer. The README says 100 and 106 including offline tests. There are six offline files, not only `benchmark-tooling`. Agent instructions give another inconsistent total.
  **Done when:** regenerate counts through test collection in a repaired environment, distinguish collected, skipped and executed tests, and update both inventories from the same evidence. Treat the source count as a diagnostic, not proof that the live suite passes.

### D19. Describe what the benchmarks actually time.
  **Location:** vault README benchmark table rows and queue benchmark description.
  **Evidence:** `benchmark.test.ts` times orchestration calls such as `startDeposit` and `startWithdraw`, which contain queue, flush and send transactions. Its table claims coverage of every vault circuit while omitting the administration and queue surface. The queue benchmark uses public approval keys for distinct token addresses and has separate proof and end-to-end timing fields.
  **Done when:** distinguish per-circuit proof measurements from orchestration elapsed time, list the actual coverage and report outputs, and explain the distinct-token setup used to obtain independent approval queue entries.

### D20. Document automatic proof-server recycling and refine OOM recovery.
  **Locations:** vault README recovery section and agent operational instructions.
  **Evidence:** `installFlowHooks` installs a pre-file readiness check and an after-file local proof-server restart. `SKIP_PROOF_SERVER_RESTART` disables recycling and non-local proof servers are excluded. The docs mostly prescribe manual restarts and assert that an OOM is routine and not a defect.
  **Done when:** describe automatic behaviour and its override, distinguish observed resource failures from guarantees, and retain manual recovery only for the cases the hooks do not recover. Verify responder retries and backfill against the pinned responder before asserting that a restart always restores progress.

### D21. Add recovery for a request interrupted between queue and send.
  **Locations:** vault README Test run recovery and agent operational instructions.
  **Evidence:** start flows print the request-id banner only after queue, flush and send. A crash can therefore leave a burned coin and pending queue entry before any request id is printed. The instruction that no request-id banner means there is nothing to resume is unsafe for this lifecycle.
  **Done when:** provide a verified way to locate the existing queue key, inspect whether it is stamped, and complete its send before considering a new request. State which recovery data is available from the ledger and logs. If the existing tooling cannot support this, create a separate implementation task and do not promise recovery that has not been demonstrated.

### D22. Correct the circuit-versus-wrapper idempotence claim.
  **Location:** vault README Deploying command comments around line 601.
  **Evidence:** the Compact `initialise` circuit rejects a second invocation. The deployment wrapper checks the ledger and returns `AlreadyInitialised` without invoking it again.
  **Done when:** attribute rerun safety to the wrapper and keep the circuit's one-shot precondition explicit.

### D23. Refresh network setup guidance from available configuration.
  **Locations:** vault README real-MPC section and agent operational instructions.
  **Evidence:** agent instructions name the `midnight-cache-storage-dev` bucket. Both the supplied guide and the installed SDK's executed cache lookup return `midnight-cache-storage-testnet`. Setup and initialisation also support `EVM_START_HEIGHT` and EVM target overrides absent from the short setup explanation.
  **Done when:** prefer the SDK cache resolver, retain explicit local-cache instructions, document the height override and pinning implications, and verify public-network availability before saying every listed network is usable. Keep the correct current limitation that swap, supply and redeem execution polls require tracing even when transfer polls use the cache.

### D24. Revalidate timing, memory and package-size figures.
  **Locations:** vault README Running it, e2e suite and package-size sections, agent operational instructions.
  **Evidence:** the text contains exact duration, memory and key-size claims beside outdated circuit counts. The audit did not generate current prover keys, pack a release or run live proofs.
  **Done when:** replace these figures with measured values tied to a version and environment, or clearly labelled estimates. Recheck the claim that key generation and a complete fresh suite finish within the stated combined duration. Preserve the actual packaging contract that omits prover keys and verifies regenerated assets against the shipped manifest.

### D25. Update output-polling references and document the circuit-input conversion.
  **Locations:** supply/redeem attestation steps, withdraw settlement step and shared settlement guidance.
  **Evidence:** `fetchExecutedSupplyOutput` and `fetchExecutedRedeemOutput` are absent from their linked files. Their polls delegate to `pollAttestedExecution` in `attested-execution.ts`. `settleWithdraw` selects the circuit after polling, while the page attributes that selection to `completeWithdraw`. All settle flows call `respondBidirectionalEventToCircuitInput`, which the updated guide explicitly explains.
  **Done when:** link the current functions, explain memoisation and candidate selection once, and tell integrators to perform the SDK's event-to-circuit conversion before calling Compact. Preserve the difference between packed respond bytes and EVM ABI return words.

## Audit findings: Compact comments

### D26. Correct misplaced and inaccurate Compact comments.
  **Locations:** contract header, `approveStataBinder`, `startWithdraw`, `startSwap`, `SupplyRequest`, `RedeemRequest`.
  **Evidence:** the header attributes EVM execution to the MPC. The `approveStataBinder` comment describes an approval transaction although its body returns a fixed binder. Several start/type comments describe recording an MPC request although the relevant circuit only queues it.
  **Done when:** the header identifies the relayer's broadcast and the MPC's signing/attestation roles. Binder comments describe key identity and collision scope. Keep burn and queue invariants on the start circuits and request publication invariants on the send circuits. Remove mechanical narration.

### D27. Add concise comments for the new ledger and transition invariants.
  **Locations:** `unflushed`, `lastSeenEvmHeight`, `seenEvmHeights`, `pendingVaultRequests`, `stamps`, `nonceOwners`, `PendingVaultRequest`, `Stamp`, administration and send circuits.
  **Evidence:** these fields and transitions contain little or no explanation of their cross-circuit relationships. A reader must currently reconstruct nonce ownership, height propagation and per-kind field meanings from many circuit bodies.
  **Done when:** document the invariants that would break if edited blindly, including the meaning of `addressA`/`addressB` by kind, deposit-only fee fields, the lifetime of a stamp and nonce reservation, and permissionless sends preserving the queued requester. Keep each explanation at its definition and avoid duplicating SDK verifier semantics at call sites.

### D28. Complete hash-site and punctuation maintenance.
  **Locations:** `approveRouterBinder`, `depositBinder`, contract comments at lines 443 and 710, vault README line 524, diagram guide line 207.
  **Evidence:** the new binder functions call `transientHash` without the fork consequence documented at the other local hash definitions. The four identified prose locations contain semicolons.
  **Done when:** document the consequences of a ledger-era hash change for pending binder-keyed entries, including deposits that cannot use a refund circuit. Reword prose punctuation while preserving Compact statement terminators and technical style strings. Agent instruction files are exempt from the punctuation rule.

### D29. Narrow unsupported economic and privacy guarantees.
  **Locations:** swap and supply introductions, redeem settlement explanation, Compact allowance and redeem comments, flow-page mint-nonce descriptions.
  **Evidence:** swap/supply prose says value or tokens never leave the vault account while later steps explicitly transfer underlying assets out and return other assets. Redeem prose promises at least the supplied principal, but the circuit mints the attested asset amount and does not enforce that lower bound. Random mint nonces prevent the specific public-request-id linkage described in the code, not every possible observation-based link.
  **Done when:** describe the actual outgoing and incoming assets, the attested amount the circuit mints, and the precise linkage random nonces avoid. Remove absolute return, permanence and anonymity claims unless separately established. Keep assumptions about token and wrapper behaviour explicit.

## Audit findings: documentation conventions

### D30. Reconcile the two diagram guides before applying the flow edits.
  **Locations:** `docs/diagramming.md` Flow diagram membership and Working size, `docs/flow-pages.md` reference section.
  **Evidence:** the membership guide says actor-level behaviour notes live on the actor map alone, then specifies how every flow's `n-read` behaviour note must vary. The page guide names the upstream section as Sign Bidirectional Flow, while the supplied guide calls it Sign Bidirectional Protocol Flow. The style guide hard-codes a sanctioned actor-map size despite the missing members.
  **Done when:** settle the `n-read` exception explicitly, name the current reference heading, and replace or remeasure geometry-specific claims when the actor map is updated. Extend the phase/verb vocabulary only where queue and flush actions require it, preserving existing curated geometry outside the affected cells.

### D31. Make prose scope and snippet promises accurate.
  **Locations:** root Contributor Guide, vault README The flows and Package layout.
  **Evidence:** the flow overview promises full code excerpts, while the pages intentionally link to implementation and contain no such excerpts. The root calls unit testing simulator-only even though deploy, tooling and harness tests also run. The contract package includes a Node CLI under `src/bin` and `src/zk-assets` while its curated import surface is environment-agnostic.
  **Done when:** describe what readers actually get, distinguish offline tests from contract simulator tests, and scope browser compatibility to the curated import surface. Explain the asset-generation CLI as a separate consumer without implying it is browser code.

### D32. Have the agent reconcile factual contradictions in maintained instructions.
  **Locations for agent maintenance:** repository rules and e2e operational instructions.
  **Evidence:** the rules call the identity section three rules although it contains five bullets. They say vitest stays exclusively in the test harness, while all three example members declare it. They mandate fixed dependency versions while explicitly describing caret ranges for TypeScript and carrying other caret ranges in manifests. Operational instructions also contain the suite, cache, restart and recovery drift listed above, and describe themselves as a human runbook.
  **Done when:** resolve intended policy versus current manifests explicitly, retain the justified two-TypeScript-version arrangement until compatibility is actually rechecked, and make human-facing operational guidance complete in the README. Keep punctuation in agent-owned files out of the defect list. Do not silently change dependency policy as part of a prose tidy-up.

## Source navigation

| Findings | Supporting file |
| --- | --- |
| D01–D07, D10–D12, D14, D26–D29 | [Current Compact contract](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact:1) |
| D01–D12, D17–D24, D31 | [Vault README](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/README.md:1) |
| D01, D02, D06, D21 | [Deposit orchestration](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-deposit.ts:178) |
| D01, D02, D05, D21 | [Withdrawal orchestration](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/start-withdraw.ts:121) |
| D03, D04, D11 | [Flush and stamping](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/erc20-vault.compact:1055) |
| D04, D06, D22, D23 | [Initialisation and height resolution](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/deploy/src/initialise-vault.ts:1) |
| D08 | [Vault derivation helper](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/index.ts:25) |
| D09 | [Published contract manifest](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/package.json:43) |
| D11 | [Queue helpers and retries](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/vault-queue.ts:1) |
| D13 | [Actor-map source](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/docs/actor-map.drawio:1) |
| D14 | [Ledger path tests](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/tests/ledger-paths.test.ts:1) |
| D17 | [Zk compile skip conditions](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/steps.ts:295) |
| D18 | [Test order](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/vitest.config.ts:1) |
| D19 | [Queue benchmark](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/tests/vault-queue-benchmark.test.ts:430) |
| D20 | [Proof-server recycle hooks](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/packages/test-harness/src/flow-hooks.ts:84) |
| D24 | [Asset regeneration and integrity checks](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/contract/src/zk-assets/run.ts:261) |
| D25 | [Shared execution poll](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/attested-execution.ts:1) |
| D25 | [Withdrawal settlement](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/examples/erc20-vault/integration-tests/src/flows/complete-withdraw.ts:1) |
| D13, D30 | [Diagram guide](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/diagramming.md:1) |
| D13, D30 | [Flow-page guide](/Users/bernard/Projects/github.com/sig-net/midnight-examples-docs-align-with-implementation/docs/flow-pages.md:1) |

Reference: [updated local integrator guide](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md:140), including [runtime height checks](/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-align-with-implementation/README.md:354).

## T02 reproduction fixture additions

Append these audit cases to a temporary copy of the existing contract test file to reuse its imports and fixtures. The expectations deliberately assert the observed acceptance of the replay cases. They must become rejection assertions when implementing the corresponding fix.

```typescript
describe("T02 audit", () => {
  it("accepts height 110 after another response at 120 advances the watermark", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const secondSent: CircuitContext<VaultPrivateState> = (await deposit(contract, ctx, {
      ...VALID_DEPOSIT,
      evmNonce: VALID_DEPOSIT.evmNonce + 1n,
    })).context;
    const ids: Uint8Array[] = [...ledger(secondSent.callContext.currentQueryContext.state).depositEventMap].map(([id]) => id);
    const secondId: Uint8Array | undefined = ids.find((id) => bytesToHex(id) !== bytesToHex(requestId));
    if (!secondId) throw new Error("Missing second request");
    const secondSettled: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(
      secondSent, respond(MPC_RESPONSE_SECRET, secondId, OutputKind.executed, OUTPUT_SUCCESS, 120n),
      OUTPUT_SUCCESS, bytes(32, 0x91), CALLER_RECIPIENT,
    )).context;
    const folded: CircuitContext<VaultPrivateState> = (await contract.circuits.flush(secondSettled, padKeys([]), padKeys([secondId]))).context;
    expect(ledger(folded.callContext.currentQueryContext.state).lastSeenEvmHeight).toBe(120n);
    expect(ledger(folded.callContext.currentQueryContext.state).depositSettleViews.lookup(requestId).knownHeight).toBe(100n);
    const firstSettled: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(
      folded, respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, 110n),
      OUTPUT_SUCCESS, bytes(32, 0x92), CALLER_RECIPIENT,
    )).context;
    const final: CircuitContext<VaultPrivateState> = (await contract.circuits.flush(firstSettled, padKeys([]), padKeys([requestId]))).context;
    expect(ledger(final.callContext.currentQueryContext.state).lastSeenEvmHeight).toBe(120n);
    expect(ledger(final.callContext.currentQueryContext.state).depositEventMap.member(requestId)).toBe(false);
    expect(ledger(final.callContext.currentQueryContext.state).depositEventMap.member(secondId)).toBe(false);
  });

  it("accepts a repeated deposit attestation when its settled height is omitted from flush", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attestation: ReturnType<typeof respond> = respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, 150n);
    const settled: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(ctx, attestation, OUTPUT_SUCCESS, bytes(32, 0x93), CALLER_RECIPIENT)).context;
    const reissued: CircuitContext<VaultPrivateState> = (await deposit(contract, settled, VALID_DEPOSIT)).context;
    expect(ledger(reissued.callContext.currentQueryContext.state).depositSettleViews.lookup(requestId).knownHeight).toBe(100n);
    expect(ledger(reissued.callContext.currentQueryContext.state).seenEvmHeights.lookup(requestId)).toBe(150n);
    const replayed: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(reissued, attestation, OUTPUT_SUCCESS, bytes(32, 0x94), CALLER_RECIPIENT)).context;
    expect(ledger(replayed.callContext.currentQueryContext.state).depositEventMap.member(requestId)).toBe(false);
    expect(zswapState(replayed).outputs.length).toBeGreaterThan(0);
  });

  it("keeps a pre-send stamp unchanged when a settled height is folded later", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const queued: CircuitContext<VaultPrivateState> = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const key: Uint8Array = depositKey(ctx, VALID_DEPOSIT.evmNonce);
    const stamped: CircuitContext<VaultPrivateState> = await flushOne(contract, queued, key);
    const attestation: ReturnType<typeof respond> = respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, 150n);
    const settled: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(stamped, attestation, OUTPUT_SUCCESS, bytes(32, 0x95), CALLER_RECIPIENT)).context;
    const folded: CircuitContext<VaultPrivateState> = (await contract.circuits.flush(settled, padKeys([]), padKeys([requestId]))).context;
    expect(ledger(folded.callContext.currentQueryContext.state).lastSeenEvmHeight).toBe(150n);
    expect(stampOf(ledger(folded.callContext.currentQueryContext.state), key).knownHeight).toBe(100n);
    const reissued: CircuitContext<VaultPrivateState> = (await contract.circuits.sendDeposit(folded, key)).context;
    const replayed: CircuitContext<VaultPrivateState> = (await contract.circuits.completeDeposit(reissued, attestation, OUTPUT_SUCCESS, bytes(32, 0x96), CALLER_RECIPIENT)).context;
    expect(ledger(replayed.callContext.currentQueryContext.state).depositEventMap.member(requestId)).toBe(false);
  });
});
```
