# Diagramming plan for the midnight examples repo (working scratch)

## How to execute an item from this plan

This file is written so that "execute item X from docs-refactor-plan.md" is a
complete brief. Prime in this order before touching anything:

1. Read this file end to end: the layout section is the target state, the
   status checklist is the work, the correspondence contract governs every
   step label, and the context section carries the domain knowledge.
2. Read the binding rules chain (first bullet of "Context for executing
   agents"): AGENTS.md "Diagrams", docs/diagramming.md,
   docs/diagram-palette.drawio (through the CLI's reports, never raw), and
   drawio.config.json.
3. For markdown tasks, additionally read every document the task touches end
   to end, plus this file's layout spec for that document's altitude.
4. Check the tooling: run the CLI's `doctor` verb (see "The diagramming
   tool" in the context section).

Execute under the standing constraints below, verify per the workflow
section, and report: ordered command log, per-change outcomes, verification
evidence, every judgement call, and friction with the tool, skill, rules or
palette (friction reports drive tool improvements: be specific).

## Standing constraints (every task)

- NEVER run `git commit`, `git push`, or `git add`: report the changed file
  list instead. Committing is the repo owner's per-batch decision. Reading
  git state (`status`, `show`, `log`) is fine.
- NEVER install anything, anywhere, by any means (no npm/yarn/pip/brew,
  global or project-local). Allowed: Node's standard library, the drawio
  CLI, and preinstalled macOS tools (`sips` for downscaling and cropping).
- File content moves FILE-TO-FILE only: `cp`, shell redirection, and scripts
  that read source files and write destination files, printing only short
  confirmations (counts, booleans, asserts). NEVER retype or echo base64,
  embedded image payloads, or whole-file XML through your own output,
  heredocs, or editor tool calls: an agent has died on the output-token
  ceiling doing exactly that. Read payload-heavy models via
  `extract --elide-images`.
- Edit a `.drawio` by scripted string surgery on unique substrings with
  asserted match counts, never by retyping regions.
- Modify ONLY the files the task names. Concurrent work may dirty other
  files: leave them alone and note them in the report.
- Scratch files go in a temp directory outside the repo, filename-prefixed
  with the task's name.
- On a judgement call the rules under-determine and that is expensive to
  redo: if an orchestrator channel exists (you were spawned as a subagent),
  ask a concise question before guessing; otherwise make the call, and
  record it with its reasoning in the report.

## Documentation project layout

Four altitudes, each thin, each pointing DOWN the chain for depth: flow page
-> example README -> root README -> integration repo. Deep protocol and
integration detail lives ONCE, in the integration repo; no document skips an
altitude or duplicates the level below it.

```
├── README.md                            # 1. repo front door, thin
├── drawio.config.json                   #    render config (repo root: upward
│                                        #    search reaches every diagram)
├── docs/                                # 2. shared diagram system
│   ├── diagramming.md                   #    binding style guide
│   ├── diagram-assets/                  #    icon bank
│   ├── diagram-palette.drawio(.png)     #    copy-source palette card
│   └── sign-bidirectional-flow.drawio(.png)  # the generic protocol diagram
└── examples/erc20-vault/
    ├── README.md                        # 3. the example's front door
    └── docs/
        ├── actor-map.drawio(.png)       #    static background, no step edges
        ├── deposit/
        │   ├── deposit.md               # 4. flow page
        │   └── deposit.drawio(.png)     #    actor map + deposit's step layer
        ├── withdraw/   (same trio)
        ├── swap/       (same trio)
        ├── supply/     (same trio)
        └── redeem/     (same trio)
```

Naming: flow files carry their flow's name inside the folder
(`deposit/deposit.md`), so a file read standalone still says what it is. The
background is `actor-map.drawio`: the file IS the actor map, so the name says
so. Flow folders are named by the contract's own circuit vocabulary (truth
priority): `supply`, never "lend". Five flows exist because the contract has
five MPC round trips: deposit, withdraw, swap, supply, redeem. A markdown
link whose visible text is a literal path keeps text and target in lockstep:
a path shown to the reader is a claim about the tree. Links to flow pages
always target the full `<flow>/<flow>.md` path, even before that page lands:
the layout above fixes every flow's path, so links land ahead of pages, and
a link-resolution check classifies these targets as known-future, never as
broken.

**1. Root README** (thin, minimal duplication of the integration repo):

- Headline: what the repo is (examples integrating the sign bidirectional
  flow), with a jump link to the flow section.
- Examples: a table of contents (one row today: the ERC20 vault).
- Sign Bidirectional Flow: the generic diagram embedded (the ONLY embed of it
  anywhere), a high-level step walkthrough tied to the diagram, and a link to
  the integration repo README for depth.
- Integration guide: one high-level paragraph, then a link to the integration
  repo's integration material for depth.
- Contributor guide: unit tests and integration tests at a high level only;
  the full get-e2e-running walkthrough lives in each example's README.
- Prerequisites.
- Repository layout: kept, but radically simplified to a short annotated tree.

**2. `docs/`**: the shared diagram system only (style guide, palette, icon
bank, the generic pair). `drawio.config.json` stays at the repo root.

**3. Example README** (`examples/<name>/README.md`):

- Headline: one line on what the example is, then the circuits table: every
  exported circuit, each row linking to its flow page.
- The actors: the ACTOR MAP embedded once (every actor, every circuit name,
  only dashed derivation edges) with short actor prose including the relayer.
  No per-flow diagrams here: those live on the flow pages.
- The underlying protocol: no image, two sentences pointing UP to the root
  README's flow section (which points on to the integration repo).
- Integration guide: the same pointer shape, up to the root README's section.
- The flows: a list linking each flow folder's page.
- The operational tail: derived keys and accounts, the setup walkthrough
  (`Setup step N` convention), package layout, running, the e2e suite.

**4. Flow page** (`examples/<name>/docs/<flow>/<flow>.md`), exactly:

1. Title + one-paragraph summary of what the flow moves and settles.
2. "The protocol underneath": one or two sentences, NO diagram embed, pointing
   to the root README's flow section.
3. The flow diagram (`<flow>.drawio.png`) + a short reading guide.
4. One `### <canonical step string>` heading per step: concise paragraph
   first, the deep code walkthrough beneath it (a canonical heading appears
   exactly once per page).
5. A mermaid `sequenceDiagram` carrying the canonical strings as notes.
6. Footer: previous/next flow links in the layout's flow order, each by full
   `<flow>/<flow>.md` path whether or not the sibling page exists yet, and
   links up to the example README.

**Diagram architecture: background + one flow.** `actor-map.drawio` is the
static background every reader learns once (actors, circuit names,
derivations). Each flow diagram is a byte-copy of that background plus that
one flow's coloured step layer appended: strip the layer and `cmp` gives the
actor map back. Never rebuild the background from scratch.

## Status checklist

### Diagram system (done, keeps evolving by critique rounds)

- [x] Style guide `docs/diagramming.md`: colours, labels, truth priority
      (code > README > diagram), layered composition, captions/anchors, uniform
      padding (8/6 nodes, 12 actor boxes), visual-weight semantics (dotted
      nodes, bold greppable names, pipeline arrow flow), lane header units,
      cluster placement, hexagon hug, edge routing NEVER BREAKs, working size.
- [x] Palette card pair: every styled cell, the icon bank, the User composite,
      the MPC server cluster, lane header units, ledger record block, dotted
      node samples.
- [x] `drawio.config.json` at the repo root (scale 3, border 10).
- [x] AGENTS.md "Diagrams" section binding all of it.

### Generic diagram

- [x] `docs/sign-bidirectional-flow.drawio(.png)`: rebuilt clean, all
      conventions applied through iterative agent rounds.
- [x] Embedded in the root README's "Sign Bidirectional Flow" section.
- [ ] Replaces the integration repo's copy (C5 below).

### ERC20 vault example

- [x] Actor map: `system-map` stripped to background, all 14 circuit names in
      grouped anatomy, `deposit-flow` rebuilt as background + deposit layer
      (byte-prefix proof holds). Delivered under the pre-restructure names.
- [x] Docs restructure to the flow-folder layout: create `docs/deposit/`, move
      `deposit.md` into it, rename `deposit-flow.drawio(.png)` to
      `deposit/deposit.drawio(.png)`, rename `system-map.drawio(.png)` to
      `actor-map.drawio(.png)`, and update every link, embed and plan/rule
      reference (mover pays: grep `system-map`, `deposit-flow` and
      `docs/deposit.md` repo-wide, zero hits on the old names at the end,
      EXCLUDING this plan file: its prose and closed checklist entries record
      the old names as history, which is their job).
      Includes the diagram page names: `actor-map.drawio` gets
      `<diagram name="actor-map" id="erc20-vault-actor-map-1">`, and each flow
      file gets its own flow's name (`<diagram name="deposit"
      id="erc20-vault-deposit-1">`), which is why the background-equality
      proof compares `<root>` contents, never whole files.
      Where a markdown link's visible text is the literal path
      (`[docs/deposit.md](docs/deposit.md)`), text and target move together.
- [x] `docs/deposit.md`: full flow page (pointer section, flow diagram, six
      canonical headings with the deep dive folded per step, mermaid, footer).
- [x] Vault README first rewrite: actor map embedded over the actors list,
      relayer in the actor story, deposit deep-dive migrated out, phase-keyed
      step table, circuits table extended to all 14 circuits.
- [x] Vault README aligned to layout 3: headline + circuits-table head, "The
      underlying protocol" and "Integration guide" pointer sections (up to the
      root README, no images), flows list, operational tail ordered as derived
      keys / setup walkthrough / package layout / running / e2e suite.
- [x] Root README rewritten to layout 1: thin headline + examples table, the
      flow section keeps the only generic-diagram embed, new Integration guide
      and Contributor guide sections, Prerequisites, repository layout
      radically simplified.
- [ ] `docs/withdraw/withdraw.drawio(.png)`: derive withdraw's canonical step
      strings and freeze them in the correspondence section, then build the
      diagram as an actor-map byte-copy plus withdraw's step layer
      (withdraw / completeWithdraw / refund, settle as an explicit branch).
- [ ] `docs/withdraw/withdraw.md`: flow page over the frozen strings. Start
      the prose from the withdraw deep-dive at
      `git show beeb8f3:examples/erc20-vault/README.md` (section "Runtime:
      the other circuits"), not from scratch.
- [ ] `docs/swap/swap.drawio(.png)`: canonical strings frozen first, then the
      diagram (approveRouter precursor, swap / completeSwap).
- [ ] `docs/swap/swap.md`: flow page over the frozen strings. The same
      `beeb8f3` section carries the swap prose to start from.
- [ ] `docs/supply/supply.drawio(.png)`: canonical strings frozen first, then
      the diagram (approveStata precursor, supply / completeSupply).
- [ ] `docs/supply/supply.md`: flow page over the frozen strings. No README
      coverage exists for supply: written fresh from the contract and
      `integration-tests/src/flows/`.
- [ ] `docs/redeem/redeem.drawio(.png)`: canonical strings frozen first, then
      the diagram (redeem / completeRedeem).
- [ ] `docs/redeem/redeem.md`: flow page over the frozen strings. Written
      fresh, as for supply.

Per flow, the diagram item runs FIRST: its captions force the canonical
strings to be concrete, and the page then writes against a frozen vocabulary
(the correspondence contract makes the page derivative of the diagram's
captions). Diagram items for different flows parallelise freely (each
byte-copies the same background into its own folder). A flow's page item
starts only after its diagram item is reviewed.
- [x] Circuits table links every exported circuit to its flow page by full
      path, ahead of the pages landing. `initialize`, being deployment setup
      rather than an MPC flow, links its own Setup step 4 heading instead.
- [ ] Vault README e2e numbers refreshed from an executed run: the README says
      eight specs / 78 tests, while `integration-tests/vitest.config.ts` pins
      ten specs in `FILE_ORDER` and `benchmark-tooling.test.ts` also exists.
      Three sites move together: the Package layout `integration-tests/` row,
      the `test:erc20-vault:e2e` script comment, and the e2e suite table.
      Counts come from running the suite, never from reading it.
- [ ] Real-network operating guidance re-homed under the vault README's
      "Running it": Running against Sepolia, `STEP_THROUGH=1`, the roughly
      20–25 minute first run and what a green run prints. Source text:
      `git show beeb8f3:README.md`.
- [ ] Contract comment markers in `erc20-vault.compact` still carry the old
      five-step numbering (`Runtime step 1 (deposit)`, `Runtime step 5
      (deposit)`). Renumber to the six-step deposit ordinals so the greppable
      marker correspondence can return to the docs.

### Enforcement and machinery

- [ ] C1 `scripts/check-diagram-labels.mjs`: the five checks below, iterating
      every `examples/*/docs/*/*.md` flow page. Planted violation proven.
- [ ] C2 CI wiring (check script on every PR; pin the render tool checkout by
      commit for check 5).
- [ ] C3 AGENTS.md contract section: the correspondence contract and pair-commit
      rule as timeless rules.
- [x] C4 typo: `respondBidrectional` greps nowhere in this repo.
- [ ] C5 integration repo PR: replace its diagram with the rebuilt generic pair
      (separate PR, referenced from this repo's PR).

## The correspondence contract (KEY)

Every numbered step label appears IDENTICALLY, name and number, in three places
per flow: the flow diagram's step captions, the flow page's mermaid notes, and
the flow page's `###` headings. One vocabulary, three renderings, per flow page.

**Numbering scheme.** `Runtime step N`, ordinals per flow, 1..N in that flow's
execution order. The cross-flow skeleton is carried by the phase COLOURS (fund,
request, signature, broadcast, attestation, settle), not by the numbers: deposit
runs six steps because it begins with the user's own wallet funding the deposit
account (fund phase), while a flow with no fund step starts at 1 with request.
A flow page is flow-qualified by its title, not by its numbers. Setup keeps its
parallel `Setup step N` convention in the example README.

**Label style.** Names are verbatim from the source of truth, no paraphrase,
and the source is the leftmost of code > README > diagram that has the term:

- Circuits verbatim from `erc20-vault.compact`, with parentheses: `deposit(...)`,
  `claim(...)`, `completeWithdraw(...)`, `refund(...)`, `swap(...)`,
  `supply(...)`, `redeem(...)`.
- Events verbatim from the Signet module: `SignBidirectionalEventNotification`,
  `SignatureRespondedEvent`, `RespondBidirectionalEvent`.
- Ledger fields verbatim: `signBidirectionalEventMap`, `mpcResponseKey`,
  `vaultEvmAddress`, `refundCommitment`.

**Canonical step strings** (the deposit rendering; other flows substitute their
circuits). Wording from the README headings under truth priority, circuit
tokens in the diagram's `name(...)` form, no backticks:

1. `Runtime step 1: fund the user's deposit account`
2. `Runtime step 2: deposit(...) records the request`
3. `Runtime step 3: poll for the MPC's signature`
4. `Runtime step 4: broadcast the sweep to the EVM chain`
5. `Runtime step 5: poll for the MPC's attestation`
6. `Runtime step 6: claim(...) verifies and mints`

**Deriving a new flow's canonical strings.** The skeleton is the phase
sequence: fund only where the flow begins with the user's own wallet moving
value on the foreign chain, then request, signature, broadcast, attestation,
settle, numbered 1..N in that flow's execution order. Wording follows the
deposit strings' shape: circuit-bearing steps read `<circuit>(...) <verb
phrase from the vault README under truth priority>`, the two poll steps reuse
the deposit wording verbatim ("poll for the MPC's signature", "poll for the
MPC's attestation"), and the broadcast step names what is broadcast in README
vocabulary. Once authored, add the flow's strings to this section: from then
on they are byte-frozen.

**The five checks** (C1 implements, per flow page):

1. Collect every heading matching `^### Runtime step \d:` in each
   `examples/*/docs/*/*.md` flow page. Assert the set is non-empty per page (a
   structurally blinded guard must fail loudly).
2. Each collected heading string appears verbatim inside a ` ```mermaid ` block
   on the same page.
3. Each heading string appears in the sibling `<flow>.drawio` source in the
   page's folder.
4. Every circuit name in a step string exists as `export circuit <name>` in the
   example's `.compact` source.
5. `extract` each committed `.drawio.png` and assert the embedded cells match
   the committed `.drawio` beside it. Cell-level comparison ONLY, never a byte
   `diff` (the webapp re-serialises the embedded model).

## Tool harvest checklist (draw-io-cli)

- [x] `measure` verb: stdlib PNG decoder, model-to-pixel calibration from the
      model bounds plus the render config (residual reported as an error bar),
      per-cell ink extents and per-side padding in model units. Smoke-proven
      against a known `spacingLeft=20` cell.
- [x] Label-collision lint: edge-label boxes estimated from character counts
      and position along the pinned polyline, advisory notes for
      run-through-label and label-over-label. Planted violation proven in
      smoke, and its first run on a real diagram surfaced a genuine strike
      (see the diagram fix item below).
- [x] `extract --elide-images`: readable model dump with payloads as size
      markers, stdout by default, refuses to land on the input path. Accepts
      .drawio input as well as .png/.svg.
- [x] `extract --decode-entities`: numeric character references restored to
      source spelling (structural entities kept), so round-trip greps match.
- [x] Skill: payloads move file-to-file, never through agent output (an agent
      died on the output-token ceiling retyping base64; now a skill hard
      constraint).
- [x] Skill: reading/round-trip/verify sections teach the new flags and the
      `measure` verb.
- [x] Fix the label strike the new lint found in
      `docs/sign-bidirectional-flow.drawio`: both left-gutter labels slid clear
      via offset points, verified by lint and render.
- [ ] Two milder own-edge label touches remain in the generic diagram
      (`e-watch-notif-l` on its blue vertical, `e-start-signbi-l` near its pink
      run): lint skips a label's own edge, so only the eyeball sees them.
      Slide them clear in the next generic-diagram round.
- [ ] `cells` report: print an edge label's offset point (it shows only the
      relative position today), so agents need not extract the XML to learn
      whether an offset exists.
- [ ] Lint: consider flagging a label centred on its OWN edge's run when the
      label has no background colour (the strike class the eyeball keeps
      finding and the checker deliberately skips today).
- [x] Palette `circuit-node` sample text cell widened to the measured Menlo
      advance (7.21 u/char: 196u for 27 chars, box 234) so copies inherit a
      cell that fits its own text.
- [ ] `render` rejects `--force` with a bare "unexpected argument": say in the
      error that render always overwrites derived outputs, no flag needed.

## Workflow (edit, verify, report)

1. Edit the committed `.drawio` XML: every edge has `source` and `target` and
   a pinned, waypointed route.
2. `lint --strict` must pass. Read every advisory note it prints: fix what is
   fixable, justify what is anchor-caused in the report.
3. Render the PNG with the CLI from the final XML state (the repo config
   supplies scale and border: pass no overrides). Render EVERY pair the
   change touched. Never copy a PNG.
4. Eyeball every render: downscale (`sips -Z 1600`), read it as an image, and
   zoom (`sips -c`) into dense regions. Broken labels, overlaps, escaped
   containment and missing icons are visible at a glance and invisible in
   the XML. The `measure` verb answers padding questions in numbers.
5. Grep the correspondence: each canonical string exactly once in its flow
   diagram, exactly twice on its flow page (one heading, one mermaid note).
   Round-trip checks against a rendered PNG's embedded model are cell-level,
   never byte-level (`extract --decode-entities` makes apostrophes
   greppable).
6. Flow diagrams carry the background-equality proof: remove the appended
   step-layer cells, then byte-compare the `<root>...</root>` contents against
   the actor map's. The `<diagram>` tag is excluded on purpose: each file
   carries its own page name and id there.
7. After writing any automated check: plant a violation, watch it fail,
   restore. A guard never seen failing is not known to work.
8. Run C1 (once it exists). The `.drawio` and its `.drawio.png` change (and
   are later committed) together, always.

## Context for executing agents

Everything an agent needs to execute a task in this plan, without this file's
authoring conversation:

- **Binding rules chain:** `AGENTS.md` section "Diagrams" binds
  `docs/diagramming.md`, `docs/diagram-palette.drawio` (the copy source for
  every styled cell, icon and composite group) and `drawio.config.json`. Read
  all four before touching a diagram.
- **The diagramming tool:** `drawio-cli`, from the `BRBussy/draw-io-cli`
  repo, checked out at `/Users/bernard/Projects/github.com/BRBussy/draw-io-cli`
  (local checkouts mirror `github.com/<org>/<repo>`). Invoke as
  `node /Users/bernard/Projects/github.com/BRBussy/draw-io-cli/src/cli.js <verb>`
  with verbs extract, render, lint [--strict], cells, styles, measure,
  doctor. `doctor` verifies the render path. The generic diagram-editing
  procedure is the global `drawio-diagrams` skill (same repo, symlinked into
  `~/.claude/skills`), which loads for any task that touches draw.io files.
- **Identifying a step layer:** every step-layer cell is an edge stroked in a
  phase colour (the style guide's colour table), a numbered circle in one, or
  a caption cell whose value starts "Runtime step"; labels riding step edges
  die with their edge. The background contains NO phase-stroked cells: the
  zero-hit check over the actor map greps `strokeColor=<phase colour>`,
  anchored to `strokeColor=` on purpose. The palette's User composite FILLS
  the person shape with #3969AC, byte-identical to the signature phase
  colour, so a bare colour grep false-positives on every actor map that
  copies it. Any automated form of this check inherits the anchor.
- **The background + flow construction:** a new `docs/<flow>/<flow>.drawio`
  starts as a byte-copy of the example's `docs/actor-map.drawio`, its
  `<diagram>` tag renamed to the flow's own name and id, plus that flow's
  step edges, circles and canonical captions appended. Never rebuild the
  background from scratch: copy it, so every flow diagram stays
  pixel-identical behind its coloured layer.
- **Protocol semantics:** the five-step walkthrough in this repo's root README
  ("Sign Bidirectional Flow") and the per-flow evidence in
  `examples/erc20-vault/integration-tests/src/flows/` (the flow files document
  who polls, who broadcasts, who settles). The relayer responsibilities belong
  to the `Vault dApp (Relayer)` actor.
- **Verifying singleton circuit names:** `@sig-net/midnight-contract` ships no
  `.compact` source, so a singleton circuit name greps nowhere as
  `export circuit`. The authoritative listing is
  `ls node_modules/@sig-net/midnight-contract/dist/managed/zkir/`
  (`signBidirectional`, `respond`, `respondBidirectional`).
- **The integration repo:** `sig-net/midnight-integration`. Links written
  into documents always target the published main branch: the external
  deep-dive every protocol pointer targets is
  `https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-flow`.
  Any WORK in that repo (task C5, which replaces its diagram pair with this
  repo's rebuilt generic pair via a separate PR) happens in the docs-branch
  workspace checkout at
  `/Users/bernard/Projects/github.com/sig-net/midnight-integration-docs-diagrams`,
  never on a main checkout.
- **Vault semantics:** the contract is
  `examples/erc20-vault/contract/src/erc20-vault.compact` (grep
  `export circuit` and `export ledger`), the executable flows are
  `examples/erc20-vault/integration-tests/src/flows/`, and the derived-keys
  story is the "Derived keys and accounts" section of
  `examples/erc20-vault/README.md`.
- **Hexagon events split left/right by reader** (generic diagram): events the
  dApp consumes sit on the left of the singleton, events feeding the MPC loop
  sit on the right. Verbatim-name labels bind the SHAPES; an edge label may
  paraphrase when the shape carrying the verbatim name is adjacent. The generic
  diagram's placeholder circuits (`startCrossChain(...)`,
  `completeCrossChain(...)`) grep nowhere by design: every other name in it
  must grep.

## Execution order (remaining)

1. C1 checks 1, 2 and 4 over the flow pages. Plant a violation, watch it
   fail, restore.
2. Withdraw diagram, then the withdraw page, then C1 checks 3 and 5.
3. Swap, supply and redeem, each as diagram then page (diagrams may run in
   parallel across flows). C3 rules.
4. C2 CI wiring.
5. C5 integration repo PR.
6. The two vault README follow-ups (e2e numbers from an executed run, the
   re-homed real-network guidance), schedulable any time.
