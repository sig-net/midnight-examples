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
- The actors: the ACTOR MAP embedded once (every actor, every member name,
  only dashed derivation edges and derivation notes, no step layer) with
  short actor prose including the relayer.
  No per-flow diagrams here: those live on the flow pages.
- The underlying protocol: no image, two sentences pointing UP to the root
  README's flow section (which points on to the integration repo).
- Integration guide: the same pointer shape, up to the root README's section.
- The flows: a list linking each flow folder's page.
- The operational tail: derived keys and accounts, the setup walkthrough
  (`Setup step N` convention), package layout, running, the e2e suite.

**4. Flow page** (`examples/<name>/docs/<flow>/<flow>.md`), exactly:

1. Title + one-paragraph summary of what the flow moves and settles.
2. `## The protocol`: one or two sentences, NO diagram embed, pointing to the
   root README's flow section.
3. `## The integration`: the same pointer shape, to the root README's
   Integration guide section.
4. `## The <flow> round trip`: a one-liner naming the round trip, then the
   flow diagram (`<flow>.drawio.png`), then a short reading guide.
5. One `### <canonical step string>` heading per step: concise paragraph
   first, the deep code walkthrough beneath it (a canonical heading appears
   exactly once per page). Supporting sections the walkthrough needs (shared
   setup, reader plumbing) follow the steps.
6. A mermaid `sequenceDiagram` carrying the canonical strings as notes.
7. Footer: previous/next flow links in the layout's flow order, each by full
   `<flow>/<flow>.md` path whether or not the sibling page exists yet, and
   links up to the example README. The first flow page carries no previous
   link and the last no next: only the links that exist appear, never a
   "Previous: none" placeholder.

**Diagram architecture: background + one flow.** `actor-map.drawio` is the
static background every reader learns once, and the ONLY diagram carrying the
contract's full anatomy (every exported circuit and pure circuit, every
witness, every ledger field). Each flow diagram
is a copy of that background with the contract members the flow does not
interact with deleted, plus that one flow's coloured step layer appended. Kept
cells stay byte-identical to the actor map's in id, value and style, with only
geometry free to adapt: the "Flow diagram membership" section of
docs/diagramming.md is the binding rule. Never rebuild the background from
scratch.

## Status checklist

### Diagram system (done, keeps evolving by critique rounds)

- [x] Style guide `docs/diagramming.md`: colours, labels, truth priority
      (code > README > diagram), layered composition, captions/anchors, uniform
      padding (8/6 nodes, 12 actor boxes), visual-weight semantics (dotted
      nodes, bold greppable names, pipeline arrow flow), lane header units,
      cluster placement, hexagon hug, edge routing NEVER BREAKs, working
      size, flow diagram membership.
- [x] Palette card pair: every styled cell, the icon bank, the User composite,
      the MPC server cluster, lane header units, ledger record block, dotted
      node samples.
- [x] `drawio.config.json` at the repo root (scale 3, border 10).
- [x] AGENTS.md "Diagrams" section binding all of it.

### Generic diagram

- [x] `docs/sign-bidirectional-flow.drawio(.png)`: rebuilt clean, all
      conventions applied through iterative agent rounds.
- [x] Embedded in the root README's "Sign Bidirectional Flow" section.
- [x] Hand-tidied generic pair normalised to the edge-label golden rules:
      the working-tree `docs/sign-bidirectional-flow.drawio` carries the
      repo owner's hand edit, whose INTENT is authoritative (actor-prefixed
      labels, initiator-directed edges, re-placed circles, the `Reads:/On:`
      note pair), plus hand-editing noise to clean by scripted surgery:
      editor inline CSS inside values (`scrollbar-color`, `light-dark`),
      unpinned and off-axis routes, the bolded verb in `e-watch-notif-l`,
      and `Submits the MPC signed transaction` respelled to `Broadcasts
      the MPC-signed transaction` per the verb table. Then lint --strict,
      re-render the pair (the committed PNG is stale), and eyeball against
      the owner's reference render
      `docs/sign-bidirectional-flow-handtidied.png`. The reference PNG and
      `docs/handtidying-notes.scratch.md` are the owner's scratch, left
      for the owner to remove.
      DONE: 19 errors and 12 warnings to zero with zero golden-rules
      label strikes, every route pinned and attached (`e-complete`,
      `e-emit-resp`, `e-emit-respbi` gained real targets), the three
      purple dApp stubs consolidated onto one anchor,
      `e-watch-foreign-l`'s bolded verb fixed alongside the named
      `e-watch-notif-l` (same defect, internal consistency), and the
      editor `<font color>` residue wrapping line breaks in
      `n-sign`/`n-attest` stripped with the rendered text proven
      byte-identical. Reference-render parity eyeballed side by side
      (the reference embeds a model byte-identical to the pre-edit
      source, so the comparison is a true before/after). Judgement
      recorded: `e-post-resp`'s 40-unit tail forces its gutter to 5u
      from the ml lane border (the alternatives reshape layout, not
      routes). The three surviving advisory notes are the `align=left`
      estimated-box artefact recorded as a harvest item.
- [x] Owner feedback round on the normalised pair: the seating and
      alignment rules STAND (text over the line, centred on the run):
      the defect is the oversized KNOCKOUT GAP. New golden rule: the
      background knockout hugs the label's text ink: the break in the
      run extends only over the actual text plus a small margin, never
      over the label box's empty padding, and a run stays visibly a
      line on both sides of its label: when the run is too short for
      that, grow the gap between the shapes rather than accepting
      orphaned stubs. Owner's named strikes: `e-start-map-l` (the
      arrowhead touches the text top while a long blank sits between
      the text bottom and the resuming stub) and `e-extract-sigs-l`
      (the green run's break swallows far more than the text). Changes:
      the rule added to docs/diagramming.md's golden-rules section,
      every riding label in the generic pair swept for oversized
      knockouts and fixed (tighten label geometry to hug text, or
      lengthen a too-short run), and the fixed pair re-copied
      byte-identically over the integration repo checkout's copy (C5's
      prepared tree must not ship the orphaned stubs). A lint check for
      knockout gaps is designed AFTER the diagram-side fix reveals the
      mechanism: recorded as a harvest item.
      DONE, and the measured mechanism differs from the diagnosis: the
      knockout ALREADY hugs the text ink (1-2u margins on every label,
      draw.io sizes the background to the text automatically), so the
      real causes were the RUN, not the label: `e-start-map`'s 45u run
      left a 9u top stub that was entirely arrowhead (fixed by growing
      the run to 75u: `cl` grew upward into space from lifting the `ml`
      lane top 30u, children re-based so every other absolute
      coordinate held), and `e-extract-sigs-l`'s top stub was crowded
      to ~5u of clean line by the step-3 circle (label slid 30u down
      its run). A sweep found three more one-sided stubs (`e-submit-l`,
      `e-watch-notif-l`, `e-extract-att-l`), all fixed by offset
      slides. Every riding label now shows 21u or more of visible line
      on both sides of a text-hugging break. The rule landed in
      docs/diagramming.md as one golden-rules bullet (visible line both
      sides, grow the shape gap for a too-short run, keep the run's
      furniture clear of the break, a vertical-run label may slide
      along its run). Lint --strict green, round-trip clean, both
      named strikes crop-verified, and the fixed pair re-copied
      byte-identically over the integration repo checkout (backup
      untouched, md5-verified).
- [x] Replaces the integration repo's copy (C5 below), AFTER the
      hand-tidied normalisation above lands: C5 ships the normalised
      pair, and the integration repo's existing diagram is KEPT as a
      renamed backup (the original hand-drawn seed of this system's
      rules), never deleted.
      DONE in the integration repo's docs-branch checkout: the seed
      renamed to `docs/sign-bidirectional-flow-hand-drawn-seed.drawio.png`
      (bytes untouched, embedded model verified, nothing references
      it), the normalised pair copied in byte-identically (the `.drawio`
      source is new there: the repo carried the PNG alone), the README
      embed resolves unchanged, lint --strict green in place. The PR
      itself remains under C5 below.

### Step-pattern refactor (before the remaining flows)

The membership rule and the `Step N` vocabulary above are the binding shape
for every flow diagram and flow page. The deposit pair predates both, so it
migrates first: no new flow work starts until these land.

- [x] Deposit diagram trimmed to the membership rule:
      `docs/deposit/deposit.drawio`'s vault contract box keeps only the
      ledger fields and circuits the deposit flow interacts with (read from
      `erc20-vault.compact` and `integration-tests/src/flows/`, list the
      survivors in the report), every other member cell deleted, kept cells
      byte-identical to the actor map's in id, value and style. Captions
      respelled from `Runtime step N:` to the re-frozen `Step N:` strings.
      Lint, re-render, eyeball, and run the workflow's membership proof.
- [x] Deposit diagram reclaims the trimmed space (the "Trimming reclaims the
      space it frees" rule in docs/diagramming.md): the band between the
      Midnight lane's bottom and the EVM lane is dead space left by the
      deleted circuit columns. Lift the EVM lane (and everything at or below
      its depth) to restore the normal inter-lane gap, re-placing the step
      circles, captions and edge runs crossing that band without collisions,
      then lint, membership proof, re-render, eyeball.
- [x] Deposit diagram's intra-lane underhang closed: inside the Midnight
      lane, the region below the vault contract box (roughly x 310..921,
      y 424..528) is explained only by the deleted circuit rows. The
      singleton lane cannot lift (its circuits are pinned level with the MPC
      note column), so closing it means re-seating the vault box within its
      lane and re-routing `e1a`, `e1b`, `e5`, `e2b`, `d2`, `d3` plus the
      step 2 and step 6 blocks, then re-lifting everything below again.
      Decide the vault-box seating rule ONCE here: every other flow diagram
      trims the same box and inherits the answer.
- [x] Deposit diagram's three own-edge label touches slid clear: lint's
      own-edge check flags `f1-l`, `g3-l` and `e4b-l`, each pixel-corroborated
      by `measure` (full-height ink where the vertical run meets the text).
      Fix before the other flows copy these riding labels into their own
      step layers.
- [x] `docs/deposit/deposit.md` restructured to flow-page layout item 4:
      "The protocol underneath" becomes `## The protocol`, a new
      `## The integration` pointer section follows it (targeting the root
      README's Integration guide), `## The deposit round trip` opens with a
      one-liner before the diagram, and the six `###` headings and six
      mermaid notes respell to the re-frozen `Step N:` strings, byte-equal
      across all three renderings.
- [x] Deposit diagram's horizontal vault-to-singleton gap settled: trimming
      took roughly 210 units off the vault box's width, growing the `vl` to
      `sl` gap from 70 (actor map) to roughly 280. Two binding texts point
      opposite ways: docs/diagramming.md says "every lane beside or below
      the shrunk containers moves in", which by its letter slides the
      singleton lane left, while the underhang item scoped its re-seat to
      the vertical band and named only vertically-affected edges. Decide
      ONCE: either pull the singleton lane (and what sits right of it) left
      to restore a normal gap, re-routing the runs that cross the band, or
      record here why the wide gap stands (the step and derivation runs
      crossing it keep it from reading as empty). Every other flow diagram
      trims the same box and inherits the answer.
      DECIDED: the singleton lane pulled in 100 units, leaving a 170-unit
      band sized to the three vertical runs the deposit flow routes through
      it. The inheritable rule (also in the context section): the singleton
      lane sits one normal lane gap (60) from the vault lane, widening only
      to hold the vertical runs that flow routes between them at the
      standard 40/45 spacing, so a flow with fewer runs pulls in further.
**Per-diagram conformance rework.** Everything each committed diagram owes
to the new rules (edge-label golden rules, verb table, witness iconography)
plus its pending syncs, packaged ONE TASK PER DIAGRAM so the reworks
parallelise across agents. Ordering constraint: the two actor-map tasks run
FIRST, in order (the conformance rework, then the derivation-edge and
note-column item), then deposit, withdraw and the generic pair (Generic
diagram section) run in parallel, as the flow diagrams byte-copy the map's
cells. Splitting
the witness-icon swap per diagram is sanctioned: the icons rule's
same-change clause guards the embeds of a CHANGED bank file, while this
swap changes no bank file (the cog is a built-in reference), so a
not-yet-reworked diagram simply still shows the cog until its task lands.

- [x] Actor-map conformance rework (FIRST): the witness member row's icon
      swaps from the cog to the open eye copied from the palette's
      iconography entry, plus a golden-rules pass over its notes and any
      edge labels. Lint --strict, phase-stroke zero-hit, frozen-string
      checks, render, eyeball crops. The vault README embed path is
      unchanged.
      DONE: the map carries zero edge labels, so the golden-rules pass
      landed on the notes. The scaffold keywords in `n-read`, `n-sign`
      and `n-attest` bolded per the note scaffold rule (values changed,
      boxes re-hugged and re-centred on the lane midpoint), the witness
      icon style byte-copied from the palette's `icono-witness-icon`,
      the three keyDerivation notes untouched. The changed note VALUES
      propagate: every diagram carrying copies of those cells inherits
      them byte-identically (the widened deposit and withdraw items
      below).
- [x] Actor-map derivation edges completed and the MPC note column
      aligned (after the conformance rework, BEFORE deposit and
      withdraw): the derivation rule says inputs present on the diagram
      point INTO each note that names them, and two gaps stand: the
      `id-vault-addr` identity node has no derivation edges though all
      three keyDerivation notes name `MIDNIGHT_VAULT_CONTRACT_ADDRESS`,
      and `MPC_ROOT_PUBLIC_KEY` points into `n-vault` and `n-respkey`
      but not `n-acct`, which also names it. Add the missing
      broad-dashed edges, consolidating on shared trunks or asking the
      orchestrator where full fan-in defeats the edge-routing rules. In
      the same change, left-align the three MPC notes (`n-read`,
      `n-sign`, `n-attest`) on one shared x so the scaffold verbs form
      a column: the "verbs aligned across siblings" rule read visually,
      matching the layered-composition rule's siblings-on-shared-
      coordinates shape, and sharpen that rule's wording in
      docs/diagramming.md in the same change so the structural-only
      reading (same scaffold shape, verb opens line 1, boxes centred at
      differing widths) is closed off. Propagation notes: the alignment
      is geometry-only and the membership proof excludes geometry, so
      it propagates nowhere, and new edges are new background cells, so
      the subset direction of the membership proof keeps existing flow
      diagrams green. Lint --strict, phase-stroke zero-hit,
      frozen-string checks, render, eyeball crops.
      DONE: four edges added (`dvaddr-respkey`, `dvaddr-vault`,
      `dvaddr-acct`, `dmpc-acct`) as a shared input bus: lint holds
      same-colour crossings as errors, which forces the derivation
      layer planar, so the vault-address feeder drops the x=981 gutter
      (collinear with `d2`'s column, disjoint in y), joins the existing
      x=1371 MPC trunk, and the bus T-drops into each note and runs on
      to `n-acct`'s bottom face. Two visible strokes, tails and leads
      legal, the model's bottom bound grew to 1360. The three MPC notes
      left-aligned on x=1415 (lane unchanged, padding 24u each side),
      and the sibling-note rule in docs/diagramming.md now says the
      boxes left-align on one shared x so the verbs read as a column.
      Propagation verified, not assumed: deposit's and withdraw's
      membership deltas are byte-identical before and after (5 and 4
      mismatches, all owned by their queued conformance items). The
      orchestrator declined the direct-route alternative: it re-anchors
      `dmpc-vault` (a style change) and widens both queued byte-copy
      lists for marginal visual gain. The map's calibration warning is
      now live (`bottom=dvaddr-acct`, explained): see the bound-setting
      edge harvest item.
- [x] Deposit conformance rework (after both actor-map tasks), in ONE
      change, byte-copying every background cell it touches from the
      reworked actor map:
      - byte-copy of the four cells the conformance rework changed
        (`code-witness-icon` plus the re-bolded `n-read`, `n-sign` and
        `n-attest` note values): the membership proof reports exactly
        those four mismatches until they land,
      - `d2` re-sync: the ledger-anatomy item re-routed the map's `d2`
        (anchor onto `acct-vault`'s top) after the deposit inherit built
        from the previous HEAD, so deposit's copy differs in style by
        exactly that pin: take the map's style byte-identically and
        re-route the polyline legally,
      - membership re-read under the withdraw precedent (a ledger field
        counts as interacted-with when the flow's own flow files name it):
        `flows/deposit.ts` names `signetRequestNonce`, `initialized`,
        `evmChainId` and `caip2Id`, so those rows join the box,
      - label audit under the edge-label golden rules: direction (`e2b`
        currently arrows INTO the MPC's Reads note, and a read points at
        the thing read), strict acting-party format on every riding label
        (`f1-l`'s cargo text respelled as a Funds action), verb table
        (`Watches for transaction execution` becomes `Picks up
        transaction execution`), alignment and seating per the
        golden rules, knockout gaps hugging the text per the
        owner-feedback rule.
      Full verification cycle, membership proof back to zero mismatches.
      DONE: the pre-change proof reported exactly the five predicted
      mismatches and nothing else (`code-witness-icon` style, the three
      re-bolded note values, `d2`'s entry pin), all byte-copied from the
      map, and the proof is back to zero over 109 background cells with
      the id set still a subset. The four ledger rows were copied whole
      (group plus box, icon and text children) from the map, so their
      ids, values and styles are the map's. Membership was re-read from
      `contract/src/erc20-vault.compact` and `flows/deposit.ts`, which
      names `before.signetRequestNonce`, `before.initialized`,
      `before.evmChainId` and `before.caip2Id`: exactly the four rows
      the item predicted, no more. Geometry: the four rows land ABOVE
      `mpcResponseKey` and the vault lane grows UPWARD, which is the
      only direction that leaves `ledger-resp` and `ledger-vaultevm`
      where they are, so `dnote3`, `dnote2` and every cell below the
      insertion stay put and the derivation notes need no jog. The
      Midnight and MPC lanes therefore both move to y=-108 (their tops
      stay level) and the vault lane keeps the even 62/62 seating in
      its parent's interior band, which the arithmetic forces: the
      singleton lane is pinned level with `code-deposit` by `e1b`, so
      the parent's bottom cannot rise above 675 and the even split
      fixes the top. Consequence recorded rather than hidden: the
      Midnight lane's right-hand column gains 168 units of empty space
      above the first keyDerivation note, the same character as the
      actor map's own gaps beside its tall vault lane, and the `e2b`
      run and its label sit in it. `d2` takes the map's
      `entryX=0.5;entryY=0` pin and re-routes to `acct-vault`'s top,
      arriving on the same x as `e3b`'s arrowhead into the bottom.
      Label audit: `e2b` reversed to `n-read` -> `ledger-evtmap` (a
      read points at the thing read), every riding label given the
      strict acting-party format (`User's EVM wallet:` over a Funds
      body for `f1-l`, `dApp/relayer:`, `MPC:`), `Watches for` becomes
      `Picks up` per the verb table, `align=left` on the four
      horizontally crossed runs and `align=center` on `e4b-l`'s
      vertical one, and every seat re-measured from the render: an
      `align=left` edge label anchors its LEFT edge at the point (not
      its centre), so each anchor is the run's start plus half the
      slack, which is what puts visible line on both sides of every
      knockout. The run band below the Midnight lane opened from 30 to
      40/50-unit spacing (and the EVM lane with everything under it
      dropped 80) because a three-line `f1-l` and a two-line `g3-l`
      cannot clear their neighbouring runs at 30: the golden
      precedence, the diagram grows. The MPC note column was
      left-aligned on the shared x=24 after the withdraw item landed
      that precedent, `e2c` taking the same off-centre SOURCE exit
      (`exitX=0;exitDx=90`) so its run into `n-sign`'s centred entry
      stays vertical, with `e4a` and `e4b` following `n-attest`'s 0.25
      and 0.75 bottom anchors to x=1252.5 and x=1329.5. `e2a`'s trunk
      stays at x=1170 and the `id-mpc-root` derivation trunk moved to
      x=1130, 40 clear of it, since the two would otherwise have run
      collinear for 98 units. Verified: lint --strict clean (three
      notes left standing, each anchor-caused on both ends: `dsecret`
      vs `d2` at 24, `d2` vs `o4` at 12 where both x are 0.5 entry
      centres 90 units apart in y, `dmpc-respkey` vs `e2a` at 22 where
      both y are note midpoints), phase-stroke zero-hit over the
      background, the six canonical captions each once in the diagram
      and twice on the page (no caption verb changed, `Watches for
      transaction execution` being a riding label that greps nowhere
      in deposit.md), membership zero mismatches, PNG re-rendered from
      the CLI with no overrides and round-tripped, crops read clean.
      The membership guard was planted with all four violation kinds
      (value, style, background phase stroke, extra id) and failed on
      every one.
- [x] Withdraw conformance rework (after both actor-map tasks, parallel
      with deposit): byte-copy of the four cells the conformance rework
      changed (`code-witness-icon` plus the re-bolded `n-read`, `n-sign`
      and `n-attest` note values), and the label audit under the
      edge-label golden rules over its riding labels (acting-party
      format, verb table, alignment, run-through-centre, direction).
      Full verification cycle, membership proof zero mismatches.
      DONE: the pre-change proof reported exactly the four predicted
      mismatches and nothing else, so the four cells were byte-copied
      from the map and the proof went to zero. The re-bolded values are
      wider text, so the three MPC notes were re-hugged, and the map's
      note column copied wholesale: relative geometry x=24 with widths
      208/180/154 in an identically sized lane, which lands the
      sibling-note rule's shared left x on withdraw too. Four
      consequent re-routes, each forced by a moved anchor: `e2c` takes
      an off-centre exit on its SOURCE note (`exitX=0;exitDx=90`) so
      the run into `n-sign`'s centred entry stays vertical (the 30-unit
      gap between the two notes cannot hold a legal jog, and the
      arrowhead's own anchor stays centred), `e2a`'s trunk moves
      1260 to 1250 to keep a 40-unit tail out of the widened
      `n-sign`, and `e4a`/`e4b` follow `n-attest`'s 0.25 and 0.75
      bottom anchors to x=1332.5 and x=1409.5. Label audit: withdraw
      carries ONE riding label, `e3b-l`, a whole-text call expression
      and so a code label exempt from the acting-party format, with
      direction correct (the vault's account is the initiator) and the
      run through its vertical midpoint. Its one defect was
      `align=center` on a horizontally crossing run, now `align=left`,
      which lint had been flagging. One finding left untouched and
      reported instead of guessed: `e3b-l` bolds `destEvmAddress` but
      not `amount` though both are `WithdrawRequest` fields that grep,
      and bolding every greppable token inside a whole-text code label
      would leave almost the whole label bold. Verified: lint --strict
      clean (its one remaining note, `dmpc-respkey` and `e2a` stacked
      14 units out of column, is anchor-caused on both ends and the
      anchor rules win), phase-stroke zero-hit, each of the six
      canonical captions exactly once and no withdraw flow page exists
      so the page-side half of the frozen-string check does not apply,
      membership zero mismatches, render and crops read clean. The
      membership guard was planted with all four violation kinds: the
      phase-stroke check proved VACUOUS on the first plant (a
      background vertex given a phase stroke was re-classified as step
      layer instead of flagged), so the step layer is now identified by
      construction (phase-stroked EDGES, phase-stroked ellipses,
      "Step" captions and their children) and all four plants fail it.
      Pre-existing and out of scope: the orange `e4a` run at y=865
      clips the bottom arc of step circle `c2`, byte-identical before
      and after this change.
      FOLLOW-UP (orchestrator ruling on the `e2b` divergence): withdraw
      takes deposit's direction fix, so `e2b` now runs `n-read` to
      `ledger-evtmap`, out of the note's left face and into the event
      map's right face, both anchors centred and the flip
      direction-only (withdraw's `e2b` carries no riding label). The
      route is two corners, not a mirror of the old three-corner
      detour: straight left at y=361 (55 units clear above `n-respkey`,
      74 below the `id-mpc-root` trunk's horizontal, so withdraw needs
      no jog where deposit did), down the x=771 gutter collinear with
      `d2`'s column and disjoint from it in y, then a 50-unit lead into
      the arrowhead, with arc jumps over the derivation trunk and
      `dnote3` and no same-colour crossing. In the same change the
      vault box's ledger rows take the map's and deposit's order (nonce,
      initialized, chainid, caip2): a pure y swap among equal-height
      groups whose children are group-relative, with no edge anchored
      to any of the three moved rows. Re-verified end to end: lint
      --strict clean with the same single anchor-caused note,
      phase-stroke zero-hit, membership still zero, six captions still
      once each, re-rendered and eyeballed. Tooling note for the
      harvest: the PNG-embedded model comes back with router-recomputed
      waypoints for EVERY edge (`e5a`/`e5b` absent entirely), so a
      round-trip check can confirm values and styles but NOT routes.
      The rendered pixels were probed instead at both candidate y
      values, and they carry the authored route.
- [ ] Actor map working size settled: the completed anatomy measures
      1695x1260 model units against the style guide's roughly 1300x800
      budget, and the guide says outgrowing diagrams split rather than
      squeeze. The all-17 decision forces the overrun, so decide ONCE:
      accept the actor map as the one sanctioned exception (record it in
      docs/diagramming.md's working-size section), or split/regroup the
      anatomy. Judge against the vault README's rendered embed legibility
      at README column width before deciding.

### Derivation story upgrade (prerequisite before the remaining flows)

Design decision, frozen here: the user's vault identity secret is its OWN
random value, separate from any wallet seed (the Lace wallet cannot expose
its secret, so the `callerSecretKey` witness needs a value the app holds
itself). The contract and integration-test changes land later, so today the
repo still derives the secret from `MIDNIGHT_USER1_WALLET_SEED` via
`identitySecretFromSeed`. The diagrams and docs move ahead of the code.

**Frozen names.** The secret's future env var is `MIDNIGHT_USER1_VAULT_SECRET`
(the `USER1` spelling matching `MIDNIGHT_USER1_WALLET_SEED` and
`EVM_USER1_WALLET_SEED`, no underscore before the digit and no leading
underscore), and the diagram node carries that exact name. Diagrams render
key generation as the ABSTRACT call `keyDerivation(...)` (decision: the
concrete SDK functions `deriveEvmAddress` and `deriveMidnightResponseKey`
belong in prose docs where they can be explained, while the diagrams carry
one uniform abstract shape). Each argument is spelled as the env var that
supplies it in the integration tests, one note per derived value, arguments
one per line:

- User's deposit account: `keyDerivation(v2.0.0, MPC_ROOT_PUBLIC_KEY,
  MIDNIGHT_VAULT_CONTRACT_ADDRESS,
  userCommitment(MIDNIGHT_USER1_VAULT_SECRET))`
- Vault's own account (pinned into `vaultEvmAddress`):
  `keyDerivation(v2.0.0, MPC_ROOT_PUBLIC_KEY,
  MIDNIGHT_VAULT_CONTRACT_ADDRESS, "vault")`
- Response key (pinned into `mpcResponseKey`): `keyDerivation(v2.0.0,
  MPC_ROOT_PUBLIC_KEY, MIDNIGHT_VAULT_CONTRACT_ADDRESS,
  "midnight response key")`

The version literal is `v2.0.0`, from the SDK's
`EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation"`, and
the response-key path literal is `"midnight response key"`, the SDK's
`MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH`: never a paraphrase like
"response-key". Bold exactly the tokens that grep (env vars,
`userCommitment`, the path literals). `keyDerivation` and `v2.0.0` grep
nowhere by design, the same exemption class as the generic diagram's
placeholder circuits, and `MIDNIGHT_USER1_VAULT_SECRET` is design-ahead:
that exemption clears, and the labels get re-verified, when the
vault-secret env var and contract/test changes land.

Verifying a frozen note text is a comparison on the RENDERED text, and the
recipe is exact: extract each cell's `value` attribute FIRST, then within
that attribute decode entities (`&nbsp;` becomes a space), turn `<br>` into
a newline, remove every other tag with no substitution, collapse whitespace
runs, then match. Entity decoding must run to a FIXPOINT: stored values are
double-encoded (`&amp;amp;nbsp;` in the file is the text `&amp;nbsp;` after
one pass), so a single decode pass leaves literal `&amp;nbsp;` fragments and
every frozen string scores zero against a correct file. Three proven traps
(the fixpoint one above plus these two): decoding the whole document before
stripping tags makes the strip regex eat from the enclosing `<mxCell` tag
through the first inner `<br>` and silently destroys the text under test,
and replacing a stripped tag with a space breaks matches at token
boundaries. The per-token bolding and the argument-boundary line wraps put
tags inside the stored value, so a literal grep of the frozen string
against the raw file finds nothing by design.

- [x] Actor map upgraded with the derivation story
      (`examples/erc20-vault/docs/actor-map.drawio(.png)`), the background
      every flow diagram inherits, so this item runs FIRST:
      - New dotted-border node `MIDNIGHT_USER1_VAULT_SECRET` inside the
        dashed User cluster beside the two wallets (the point of the
        drawing: the secret lives in neither wallet), with a key/secret
        icon chosen from draw.io's built-in libraries. Add the styled cell
        to the palette card in the same change.
      - Contract anatomy completed: `witness callerSecretKey(...)` as a
        member row (keyword `witness` in the keyword colour, name bold),
        and the four `export pure circuit` rows the map is missing
        (`vaultResponseSchema(...)`, `vaultTokenDomainSeparator(...)`,
        `userCommitment(...)`, `withdrawRefundCommitment(...)`, keyword
        `pure circuit`). Widen the anatomy wording in AGENTS.md and
        docs/diagramming.md from "every exported circuit, every ledger
        field" to include pure circuits and witnesses, in the same change.
      - The three `path = ...` riding labels replaced by three dotted
        derivation-note nodes carrying the frozen call texts above, each
        with one dashed edge into what it derives: the deposit-account
        note into `User's deposit account`, the vault note into
        `ledger vaultEvmAddress`, the response-key note into
        `ledger mpcResponseKey`. The existing dashed
        `vaultEvmAddress ╌> Vault's own account` edge stays, unlabelled.
      - One dashed edge `MIDNIGHT_USER1_VAULT_SECRET ╌> witness
        callerSecretKey(...)` showing how the secret enters the contract.
      - The dashed MPC-origin edge into `mpcResponseKey` deleted: the MPC
        USES the key (its `Attests: ... With: mpcResponseKey` note already
        says so) and is not the derivation's source. The MPC root key
        appears only as the `MPC_ROOT_PUBLIC_KEY` argument in the notes.
      - The oversized vertical gap between the Midnight lane and the EVM
        Blockchain lane closed to the normal inter-lane gap, re-seating
        what the derivation notes and edges need in that band.
      - Lint --strict, render, eyeball, and re-render the vault README's
        embed (path unchanged). The zero-hit phase-stroke check over the
        background still holds (derivation cells are neutral, never
        phase-coloured).
- [x] Actor map aligned to the follow-up derivation design and neatened
      (the repo owner's editor draft on disk sketches the intent with
      webapp-id cells and inline-styled values: replace those draft cells
      with palette-clean, properly-id'd implementations):
      - Pure-circuit rows removed (the draft already dropped
        `userCommitment(...)`, the other three go too): pure circuits stay
        off the diagrams by default.
      - Contract members regrouped into vertically separated sections in
        fixed order (ledger, witness, circuits) per the new sections rule
        in docs/diagramming.md.
      - Secret node's icon switched to the crossed-eye sample the repo
        owner placed on the palette card (the palette's EXAMPLE_SECRET
        group is the copy source and its icon is authored: never redesign
        it). The palette PNG is stale against its edited source: re-render
        the palette pair.
      - The three derivation notes respelled to the frozen
        `keyDerivation(v2.0.0, ...)` strings above, broad-dashed note
        borders, arguments one per line (the draft's `v1.0` and
        `reponse-key` are superseded by the frozen strings).
      - Broad-dashed identity nodes added: `MIDNIGHT_VAULT_CONTRACT_ADDRESS`
        in the vault contract lane's header band,
        `MPC_ROOT_PUBLIC_KEY` in the MPC lane.
      - Derivation edges all broad-dashed (`dashPattern=8 8`,
        `strokeWidth=2`), the palette's derivation sample restyled to match:
        inputs present on the diagram point INTO each note that names them
        (the contract-address node, the root-key node, the secret into the
        deposit-account note), each note points at what it derives, and the
        secret keeps its edge into `witness callerSecretKey(...)`. Where
        full input fan-in defeats the edge-routing rules, consolidate on
        shared trunks or ask the orchestrator.
      - The whole map neatened per the layered-composition rule: aligned
        columns, consistent gaps, no dead bands.
      - Lint --strict both pairs, phase-stroke zero-hit, frozen-string
        rendered-text checks against .drawio and PNG model, render both
        pairs, eyeball downscaled plus crops.
- [ ] Palette follow-up, one quiet change, parallel-safe with every
      diagram rework: the EXAMPLE_SECRET icon cell still carries the bare
      webapp id `2` (kept during the icon swap to preserve the authored
      cell): rename it to `secret-node-icon` (the palette is a copy
      source, so copies made before the rename are unaffected). And the
      bank file `eye-icon.png` renames to `secret-icon.png`: the bank
      names icons by concept (`witness-icon.png` set the precedent,
      re-opening the sibling's name), embedded payloads are copies so
      only path references move (the iconography table row in
      docs/diagramming.md, any other grep hits for `eye-icon.png`: mover
      pays, grep repo-wide and update every hit).
- [x] Iconography formalised: palette and rules only, no flow or actor
      diagrams touched. The icons are a SEMANTIC layer, one concept one
      icon, decoupled from any single cell type so later documentation work
      can reuse them (e.g. a "ledger tip" callout box in prose docs
      carrying the database cylinder, threading ledger topics through the
      documentation by icon). In one change:
      - `docs/diagram-assets/witness-icon.png` (the repo owner's open-eye
        icon, verified genuine PNG, 512x512 RGBA) joins the bank: commit
        it, it is untracked today. The open eye (witness observes) pairs
        deliberately with the crossed eye (secret stays hidden).
      - The palette card gains an "Iconography" section: a rendered
        concept-to-icon table (ledger state: database cylinder, circuit:
        cog, witness: open eye, secret: crossed eye, plus the actor/lane
        icons already in the bank row), each entry the copy source for that
        concept's icon cell. The witness entry embeds the new icon.
      - docs/diagramming.md gains a matching iconography table as a named
        subsection, and the member-row and node rules point at it instead
        of hardcoding per-shape icon choices in prose, so a new icon lands
        by extending one table.
      - Verification: lint --strict on the palette pair, re-render it,
        eyeball crops of every iconography entry at display size.
- [ ] Witness icon swept through the diagrams: SUPERSEDED by the
      per-diagram conformance rework tasks in the Step-pattern refactor
      section, which carry the swap one diagram at a time (the split is
      sanctioned there). This entry stays only so the sweep's history has
      a home: no work happens under it.
- [x] Deposit pair and docs inherit the derivation story, after the actor
      map item is reviewed:
      - `docs/deposit/deposit.drawio(.png)`: sync the background to the
        upgraded actor map, byte-identically (id, value, style). The sync is
        NOT additive-only: the actor map deleted `d1`, `d3` and the three
        `path = ...` riding labels (`d1-l`, `d2-l`, `d3-l`) and re-routed
        `d2`, and it bolded every member name in the 17 pre-existing
        circuit-row texts, so the deposit copies of all those cells change
        or die too. Copy the new background cells the deposit flow needs
        from the actor map.
        Membership grows by `witness callerSecretKey(...)` only: pure
        circuits stay off the diagrams by default, so no
        `userCommitment(...)` row even though the deposit-account note
        names it. The response-key note is the
        natural occupant of the vault-to-singleton horizontal band, which
        may settle the gap item above: decide them together. Re-run lint,
        membership proof, render, eyeball, and the correspondence grep
        (step strings are untouched by this change).
      - `docs/deposit/deposit.md` and the vault README's "Derived keys and
        accounts" section respelled to the frozen vocabulary: the secret
        as `MIDNIGHT_USER1_VAULT_SECRET` (noting the env var lands with the
        code change), derivation described via the SDK's `deriveEvmAddress`
        and `deriveMidnightResponseKey` as the concrete functions behind
        the diagrams' abstract `keyDerivation(...)` notes, naming that
        correspondence once so a reader can map note to function.
      - Design update only: no contract, test, or env-var code changes in
        this item.

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
- [x] Actor map ledger anatomy completed: the contract exports 17 ledger
      fields while the map carries 3 (`signBidirectionalEventMap`,
      `mpcResponseKey`, `vaultEvmAddress`), so the missing 14 join the
      ledger section, in two columns as the circuits section already does,
      record types as record blocks and scalars as single lines, styled
      from the existing ledger rows, and the map pair re-rendered (the
      vault README's embed path is unchanged). Decision recorded: the
      anatomy completes literally, the rule stands as written ("every
      ledger field"), no grouping.
- [x] `docs/withdraw/withdraw.drawio(.png)`: canonical step strings frozen
      in the correspondence section (done above), then build the
      diagram per the background + flow construction (actor-map copy, trimmed
      to withdraw's interacted members, step layer appended) for
      withdraw / completeWithdraw / refund, settle as an explicit branch.
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
      (deposit)`). Respell to the `Step N (deposit)` vocabulary and renumber
      to the six-step deposit ordinals so the greppable marker correspondence
      can return to the docs.

### Enforcement and machinery

- [ ] C1 `scripts/check-diagram-labels.mjs`: the six checks below, iterating
      every `examples/*/docs/*/*.md` flow page. Planted violation proven.
- [ ] C2 CI wiring (check script on every PR; pin the render tool checkout by
      commit for check 5).
- [ ] C3 AGENTS.md contract section: the correspondence contract and pair-commit
      rule as timeless rules.
- [x] C4 typo: `respondBidrectional` greps nowhere in this repo.
- [ ] C5 integration repo PR: replace its diagram with the rebuilt generic pair
      (separate PR, referenced from this repo's PR). The repo's existing
      diagram is KEPT as a renamed backup (the original hand-drawn seed of
      this system's rules), never deleted.
      Working tree PREPARED (the Generic diagram section's replaces item
      records the change and its verification) and the PR title and
      description are drafted in the executing agent's report: what
      remains is the owner's step, commit, push and PR open in
      `midnight-integration-docs-diagrams`, linking the examples PR once
      that exists. Two owner decisions ride with it: whether to note in
      the integration repo that the examples repo is canonical for
      future edits of this diagram, and whether that repo needs its own
      `drawio.config.json` (today the CLI defaults coincide with the
      examples repo's committed scale 3, border 10, so drift is
      currently invisible).

## The correspondence contract (KEY)

Every numbered step label appears IDENTICALLY, name and number, in three places
per flow: the flow diagram's step captions, the flow page's mermaid notes, and
the flow page's `###` headings. One vocabulary, three renderings, per flow page.

**Numbering scheme.** `Step N`, ordinals per flow, 1..N in that flow's
execution order. The label carries no runtime qualifier: a flow page holds
only runtime steps, so the word said nothing (setup lives in the example
README, nowhere else). The cross-flow skeleton is carried by the phase COLOURS (fund,
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

1. `Step 1: fund the user's deposit account`
2. `Step 2: deposit(...) records the request`
3. `Step 3: poll for the MPC's signature`
4. `Step 4: broadcast the sweep to the EVM chain`
5. `Step 5: poll for the MPC's attestation`
6. `Step 6: claim(...) verifies and mints`

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

**Canonical step strings, withdraw** (frozen). Withdraw has no fund step, and
its settle is a branch whose two arms share ordinal 5, exactly as the
contract's own step comments number them (`Runtime step 5 (withdraw):
completeWithdraw() / refund()`). Wording from the vault README's withdraw
deep-dive (`git show beeb8f3:examples/erc20-vault/README.md`, section
"Withdraw") under truth priority:

1. `Step 1: withdraw(...) burns the surrendered coin and records the request`
2. `Step 2: poll for the MPC's signature`
3. `Step 3: broadcast the transfer to the EVM chain`
4. `Step 4: poll for the MPC's attestation`
5. `Step 5: completeWithdraw(...) settles on the attested output`
6. `Step 5: refund(...) re-mints when the transfer never executed`

A settle branch shares one ordinal with one canonical string per arm, and
each arm's string still appears exactly once per diagram and twice per page
(two `### Step 5:` headings each satisfy check 1's regex on their own).

**The six checks** (C1 implements, per flow page):

1. Collect every heading matching `^### Step \d+:` in each
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
6. Strip each flow diagram's step layer and assert every remaining cell
   matches the actor map's cell of the same id on id, value and style
   (geometry excluded), and that the remaining id set is a subset of the
   actor map's.

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
- [x] Own-edge label touches in the generic diagram slid clear via offset
      points: the new own-edge lint check (below) flagged five
      (`e-user-dapp-l`, `e-start-map-l`, `e-watch-notif-l`, `e-read-map-l`,
      `e-watch-foreign-l`, all pixel-corroborated by `measure`), and
      `e-start-signbi-l` (the near-parallel touch class lint cannot see) was
      slid above its run by hand. Verified by lint, re-render and eyeball.
- [x] `cells` report: an `ELBL` row now shows its owning edge, relative
      position and offset point instead of a meaningless absolute origin.
      Smoke-proven.
- [x] Lint: own-edge label check implemented as an advisory note, scoped to a
      backgroundless label crossed by its own edge's VERTICAL run (pixel
      evidence shows the webapp knocks the line out behind the text, so a
      label along its own horizontal run is fine, while a perpendicular
      crossing leaves a touching gap). Smoke-proven with a planted violation
      and a background-colour control.
- [x] Palette `circuit-node` sample text cell widened to the measured Menlo
      advance (7.21 u/char: 196u for 27 chars, box 234) so copies inherit a
      cell that fits its own text.
- [x] `render --force` now fails with "render always overwrites its derived
      outputs, no flag needed: drop --force". Smoke-proven.
- [x] `measure` on an edge label resolves its anchor from the parent edge's
      pinned polyline (helpers shared with lint) and measures ink inside its
      estimated box, reporting anchor, position and offset. Ink includes the
      edge's own stroke on purpose: zero top or bottom padding on a riding
      label is how a touching line shows up in numbers. Smoke-proven.
- [x] `measure` ink-height disagreement resolved: no tool defect. The two
      captions wrap to different line counts (step 1 to three lines in its
      110u box, step 4 to four in its 85u box), confirmed by crops, and ink
      is glyph and line-count dependent by design. Trust the verb.
- [x] `measure`'s calibration warning now names suspects: estimated
      edge-label boxes overhanging the model bounds (labels never count
      toward bounds, the usual cause), or failing that the cells that set
      each bound. On the generic diagram it names `e-extract-sigs-l` (~106u)
      and `e-submit-l` (~62u), the deliberately offset left-gutter labels,
      fully explaining the residual.
- [x] `cells --full` prints untruncated style strings (image payloads stay
      elided). Declared width/height was already in every vertex row.
      Smoke-proven.
- [x] `measure --cell <group-or-container>` now also reports every vertex
      child's ink and padding, so box-hug questions are answerable directly.
      Verified against the deposit vault box (`vl` reports all six members).
- [x] `cells --xml <id>` (or `extract --raw-slice <id>`): print the exact
      source bytes of one cell's element from the raw file. `cells` and
      `extract` both re-serialise (`/>` spacing, geometry elements
      self-closed differently from the file), so substrings copied from
      their reports fail to match the file in string surgery: the underhang
      edit script failed 12 of 13 patches this way on its first run.
      DONE as `cells --xml <id>`, with `--elide-images` for payload cells:
      byte-verbatim slice (id-bearing `object`/`UserObject` wrappers
      sliced whole), unknown and duplicate ids fail loudly. Smoke-proven
      with planted violations, byte-verbatim re-verified on the actor
      map's `code-witness-icon`.
- [ ] Editing verbs that write the raw file in place preserving its
      serialisation: `set-geometry <id> --x/--y/--width/--height`,
      `set-waypoints <id> "x1,y1 x2,y2 ..."`, `set-label-offset <id> <dx>
      <dy>`. Every geometry change today is hand-computed model arithmetic
      (lane interiors, box centres, polyline lengths for label `pos`) turned
      into regex surgery, which carries both arithmetic and serialisation
      risk.
- [ ] `measure` on an edge label: report the label's own text-ink bbox
      separately from foreign ink inside the estimated box, and tighten the
      char-width estimate toward measured Helvetica ink (about 6 u/char
      against the roughly 7.08 used). `g3-l` reported all-zero padding,
      which reads as "a line touches this text on all four sides", when the
      cause was the over-wide estimated box clipping an unrelated edge that
      the crop shows 27 units clear of the text.
- [x] `measure` calibration warning: suppress it below a threshold or behind
      a `--quiet-calibration` flag once the residual is fully attributed. On
      the deposit diagram it fires twice per invocation, always naming the
      same four bound-setting cells for an explained, harmless 27px
      residual.
      DONE, both halves: a residual at or below the render border in
      pixels (`border * scale`) AND fully attributed to named edge-label
      overhangs demotes to a one-line note (the deposit and withdraw
      pairs now demote), and `--quiet-calibration` drops the calibration
      lines but NEVER a live WARNING (the generic pair's unexplained
      residual stays loud). Smoke-proven both directions.
- [ ] `measure --gaps <container>`: report each child's clearance to the
      container's four sides and the largest empty rectangle inside it. The
      underhang item, a pure dead-space question, was answered by
      transcribing lane geometry out of `cells` and subtracting by hand.
- [ ] Lint: flag an edge-label box overhanging the model bounds by more than
      the render border. Labels never extend the export bounds, so a slid
      label clips silently: `e4b-l`'s clearance inside the right bound was
      hand-checked against the border arithmetic.
- [x] `measure` (or `render`) prints the model-to-pixel affine on request
      (scale and offset per axis), so a `sips -c` crop of a model region is
      one computation instead of three. Every crop in the actor-map upgrade
      needed the calibration line transcribed and applied by hand.
      DONE as `measure --affine` (valid with no `--cell`): four
      substituted formulas, px from mx and back per axis, printed from
      the same calibration the verb measures with. Hand-applying them to
      `n-read`'s box reproduced measure's own ink numbers exactly.
- [ ] Lint: check leads as well as tails (the tail check catches a first
      segment under 40 units out of the source, but nothing checks the
      final segment into the arrowhead), and flag a shape-to-edge clearance
      under 20 units for edges passing close to unrelated shapes. Both were
      eyeball-only on the deposit inherit rebuild, and the tail check's
      three genuine catches there show the lead-side twin would pay for
      itself.
- [x] Golden-rules lint suite, four checks landed and smoke-proven, the
      own-edge advisory check retired in the same change (superseded: a
      vertical run crossing text is now the sanctioned default):
      - Run-through-centre (note tier): straddle the run centred, or sit
        legally alongside (run on the label's left, top or bottom, never
        its right). Fires zero strikes on all committed diagrams: the
        audit ahead is about align tokens and format, not seating.
      - Alignment vs crossing axis (note tier): `align=left` for a
        horizontal crossing, `align=center` for a vertical run, the
        alongside case included.
      - Format (note tier): first line bold and colon-terminated, body
        starting with a capital. Whole-text call expressions exempt as
        code labels.
      - Editor junk (warning tier): `scrollbar-color`, `light-dark(`, and
        `color:`/`background-color:` inside value markup, with the
        palette's Menlo code scaffold sanctioned by shape.
      - Specimen exemption: labels on edges whose both endpoints are
        degenerate points (4u or smaller) are legend captions, exempt
        from alignment and format, still seated by check 1, and exempted
        labels are named in a per-check vacuity note so coverage loss is
        visible.
      - Every check guarded: planted violations seen firing, each check
        blinded in turn with exactly its own assertion failing, vacuity
        notes ending "(vacuous, not green)".
- [ ] Lint: label-over-label overlap promotes from advisory to error once
      label boxes come from measured ink instead of char estimates (the
      measured-ink rework is the `measure` edge-label item above).
- [ ] Lint (advisory, later): initiator direction: the bold prefix should
      name the edge's source-side lane or actor, via a small per-diagram
      alias table.
- [ ] Golden-rules checks promoted from note to error tier. The
      run-through-centre, alignment and format checks land as ADVISORY
      NOTES only so `lint --strict` stays green on committed diagrams that
      predate the label rules. That grace period ends when the conformance
      items land: "Hand-tidied generic pair normalised to the edge-label
      golden rules" (Generic diagram section) and the three per-diagram
      conformance rework tasks (Step-pattern refactor section: actor map,
      deposit, withdraw). The moment all four are ticked, promote all three
      checks to errors in the CLI, re-run `lint --strict` over every
      committed pair in this repo, and fix anything that fires: a note
      tier left permanent is a rule nobody is held to.
- [ ] Lint or membership tooling: flag a re-anchored background edge by
      name. `exitX`/`entryY` live in style, so re-routing an inherited edge
      silently breaks the flow-membership byte-identity, and only the
      membership script's generic "style differs" catches it. A check that
      says "background edge re-anchored: <id>" turns a puzzling diff into a
      named defect.
- [ ] Lint: narrow the stacked/parallel-run checks to runs whose x (or y)
      spans actually overlap. Runs 60 units apart horizontally are
      currently reported as stacked, and every such note costs a
      read-and-justify round. Nuance from the generic-pair
      normalisation: 3 of its 4 baseline stacked notes named disjoint
      runs and aligning them was still the right fix each time, so the
      narrowing should demote such hits, not silence them.
- [ ] Lint: flag text ink wider than its box (a long unbreakable token like
      `completeWithdraw(...)` overflows its caption and paints over
      neighbours, invisible in XML and to every current check): pairs with
      the open `measure --fit` item.
- [ ] Render and lint: fail loudly when the parsed cell count is far below
      the source's `<mxCell` count. A malformed geometry splice (broken
      `<Array as="points">` handling) rendered "loaded 2 of 145 cells" as
      an easily missed log line while producing a blank-looking PNG.
- [ ] Palette: add a ledger record-block sample and a step-caption sample
      carrying a realistically long circuit token: both shapes exist in
      committed diagrams but have no copy source on the card, so agents
      reverse-engineer them from diagrams instead of copying.
- [ ] Skill: concurrent-editor guard: hash the target `.drawio` before and
      after every edit batch and re-check before finishing. Mid-task an open
      draw.io editor re-serialised `deposit.drawio` under the executing
      agent (cell order rewritten to webapp order, `d2`'s waypoints
      collapsed 4 to 2), detected only via `git diff --stat`, and an editor
      holding a stale buffer can save over finished work after the fact.
- [ ] Lint: error on any `image=` style referencing a remote host
      (`http://`/`https://`). A palette cell shipped
      `image=https://images.icon-icons.com/...`, which renders BLANK in the
      offline renderer and violates the icons rule, and nothing caught it:
      the failure is invisible in the XML and only an eyeball of the render
      shows the empty box.
- [x] `measure --fit <cell>`: print the box implied by the uniform-padding
      rule (8 side, 6 vertical) for the cell's measured text ink, so sizing
      a box takes one pass. Character-width estimates are off by about 10%
      (8.1 predicted against roughly 7.4 actual for bold Helvetica caps),
      which cost a render-measure-adjust loop per box across five boxes in
      the keyDerivation alignment.
      DONE: prints implied box (ink + 16x12) beside the declared box with
      the delta, always measuring the cell in full first. An edge label
      says "nothing to fit" rather than a delta against an estimated box.
      The ink-wider-than-box LINT item below stays open and still pairs
      with the measured-ink edge-label rework.
- [ ] `measure --fit` on a stroked shape counts the border as ink:
      `--fit hex-resp` on the generic pair advises growing a hexagon
      that already hugs its label. Restrict the fit verdict to text
      ink, or subtract a detected border rectangle before applying the
      8/6 padding.
- [ ] measure and lint centre an `align=left` edge label's estimated
      box on its anchor, but mxGraph places such a label with its LEFT
      edge at the anchor: a half-width error that produced 5 of the 8
      surviving advisory notes on the normalised generic pair (four of
      them on `e-complete-l` alone), each costing a crop-and-disprove
      round, and it makes the seating check's x verdict unreliable for
      `align=left` labels crossed by a vertical run. Pairs with the
      measured-ink edge-label item above. Confirmed by pixel
      measurement on a synthetic fixture (103u single-line label,
      anchor at model x=200, scale 3, ink scanned from the render and
      mapped back through the render's own affine): `align=center` ink
      spans 149.3..252.7u centred on the anchor, `align=left` ink
      spans 201.7..305u with the text's LEFT edge on the anchor.
      Incidental from the same fixture: a label with no
      `verticalAlign` token renders its text about 12u below the
      anchor, while `verticalAlign=middle` centres it (166.7..174.3u
      for an anchor at y=170): the palette's edge-label style carries
      the token, so committed diagrams are unaffected in practice.
- [ ] `measure --affine` (and the calibration under it) reports a bogus
      affine with a huge residual shift when the PNG was rendered at a
      scale other than the config's (a scale-1 render produced a
      nonsensical -1182,-837px shift with no hint of the cause): detect
      the scale mismatch and warn loudly instead of publishing numbers.
- [ ] Lint editor-junk check learns `<font color="...">` as a junk
      token: the generic pair's `n-sign` and `n-attest` carried
      `<font color="#000000"><br></font>` (editor residue wrapping an
      invisible line break), which the inline-CSS token matching does
      not see.
- [ ] `measure` flag parsing after `--cell <id>`: `--fit` given in the
      form `--cell <id> --fit` is silently swallowed as a valueless
      flag (no fit line, no error: the working form is `--fit <id>`),
      and `--quiet-calibration` after `--cell <id>` is consumed by the
      variadic id list ("cell --quiet-calibration: not a vertex") while
      the chatter prints anyway. Parse flags before variadic ids, or
      fail loudly.
- [ ] `measure --fit` double-counts a text cell's own spacing tokens:
      `n-read` carries `spacingLeft=8;spacingRight=8`, its measured ink
      already sits inside that inset, and the fit adds the 8u rule on
      top ("delta +12x+2" on a correctly hugged box). Subtract declared
      spacing from the implied box, or name the spacing in the verdict.
- [ ] Calibration demotion covers only edge-LABEL overhangs, so a
      bound-setting EDGE keeps the warning loud forever: the actor map
      now warns on `bottom=dvaddr-acct` with a fully explained 30px
      residual (the webapp pads an edge's bounds beyond its declared
      polyline). Extend the demotion to an attributed bound-setting
      edge whose residual sits within the border.
- [ ] Guide-vs-tool gap on same-colour crossings, a DECISION before any
      code: lint holds every crossing of two default-stroked edges as
      an ERROR (which forces the derivation layer planar and drove the
      actor map's bus design), while docs/diagramming.md scopes the
      no-crossing rule to step colours and elsewhere invites
      `jumpStyle=arc`. Either the guide states plainly that neutral
      edges may not cross either and jumps are for step layers only, or
      the check exempts crossings carrying an explicit jump. A design
      round was burned on the gap.
- [ ] Skill: note in the verify section that the model-to-pixel affine
      changes whenever an edit moves the model bounds, so
      `measure --affine` is re-read after every render, never cached
      across edits (the actor-map bus grew the bottom bound and shifted
      the y offset mid-task).
- [ ] Lint: visible-run check (the knockout-gap check, re-aimed by the
      measured mechanism): the knockout always hugs the text ink (1-2u
      margins, draw.io sizes the background automatically), so checking
      knockout padding would be vacuous. Check instead what actually
      failed: a riding label leaving less than ~20u of visible run on
      either side of its break (the orphaned-stub defect: an
      arrowhead-only stub is the worst case), and step-circle or other
      furniture crowding the stub below the same clearance. Depends on
      measured text ink, so it pairs with the measured-ink edge-label
      item. Implementation note from the fix: colour-profiling a run's
      stroke needs a tight tolerance (about +-40/channel: at +-55,
      antialiased black glyph edges match purple and fabricate phantom
      breaks).
- [ ] `measure --affine` bakes the calibration residual into its
      offset: it printed `px = (mx-347)*3 + 54` for a render whose true
      mapping is `+76` (a 22px error, enough to miss a 6px stroke),
      because the residual shift it derives includes the attributed
      label-overhang error its own calibration line warns about.
      Subtract the attributed overhang before deriving the offset, or
      refuse to print an affine while a live calibration WARNING
      stands. Distinct from the scale-mismatch item above: this fires
      at the correct scale.
- [ ] Lint: the floating-connection warning fires on palette sample edges
      whose endpoints are zero-area point shapes, where exit and entry
      sides are geometrically meaningless. The samples were pinned to
      silence it, which adds noise to satisfy a check: either exempt edges
      between zero-area shapes or accept pins as the convention and say so
      in the skill.

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
   containment, missing icons and dead bands of empty space (area only a
   deleted or moved cell explains) are visible at a glance and invisible in
   the XML. Ask of every render: does any region read as "something used to
   be here"? The `measure` verb answers padding questions in numbers.
5. Grep the correspondence: each canonical string exactly once in its flow
   diagram, exactly twice on its flow page (one heading, one mermaid note).
   Grep the FULL `Step N: ...` string, never a fragment (circuit tokens like
   `deposit(...)` recur legitimately in prose and code): the heading
   occurrence matches `^### Step \d+:`, the note occurrence sits on a
   `Note over` line inside the mermaid fence.
   Round-trip checks against a rendered PNG's embedded model are cell-level,
   never byte-level (`extract --decode-entities` makes apostrophes
   greppable).
6. Flow diagrams carry the membership proof: remove the appended step-layer
   cells, then check every remaining cell against the actor map's cell of the
   same id (id, value and style byte-identical, geometry excluded) and assert
   the remaining id set is a subset of the actor map's. Cell-level, never a
   whole-file byte compare. The `<diagram>` tag is excluded on purpose: each
   file carries its own page name and id there.
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
  a caption cell whose value starts "Step"; labels riding step edges
  die with their edge. The background contains NO phase-stroked cells: the
  zero-hit check over the actor map greps `strokeColor=<phase colour>`,
  anchored to `strokeColor=` on purpose. The palette's User composite FILLS
  the person shape with #3969AC, byte-identical to the signature phase
  colour, so a bare colour grep false-positives on every actor map that
  copies it. Any automated form of this check inherits the anchor.
- **The background + flow construction:** a new `docs/<flow>/<flow>.drawio`
  starts as a copy of the example's `docs/actor-map.drawio`, its `<diagram>`
  tag renamed to the flow's own name and id, the contract members the flow
  does not interact with deleted (the membership rule in
  docs/diagramming.md), and that flow's step edges, circles and canonical
  captions appended. Never rebuild the background from scratch: copy and
  trim, so every kept cell stays byte-identical to the actor map's in id,
  value and style, geometry free to adapt as the contract box tightens.
- **Vault-box seating after trimming (decided once on the deposit diagram,
  every flow diagram inherits it):** seat a trimmed contract lane centred
  vertically in its parent lane's interior band, the band from the bottom of
  the parent's header (`lane.y + startSize`) to the parent's bottom edge.
  The parent's height is fixed by whatever inside it cannot move (in the
  Midnight lane, the singleton lane pinned level with the MPC note column),
  so trimming leaves slack that cannot leave the diagram: an even split
  reads as lane padding, any uneven split leaves the larger band reading as
  a deletion scar. Never stretch the box's contents to fill the slack.
  Re-route corollaries: every edge landing on a moved member shifts by the
  same delta, a jog the delta shortens under about 40 units straightens
  instead, a previously straight edge the delta would leave diagonal gets an
  explicit two-corner jog in the nearest gutter (the anchor rules beat
  straightness), and an off-centre anchor needed for a straight run goes on
  the tall source box, never on the note the arrowhead lands in.
- **Vault-to-singleton band sizing (decided once on the deposit diagram,
  every flow diagram inherits it):** the singleton lane sits one normal
  lane gap (60 units) from the vault lane, widening only to hold the
  vertical runs that flow routes between the two lanes, at the standard
  40/45 run spacing with 40 units of clearance each side. A flow with
  fewer runs pulls the singleton lane in further.
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
  `https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-flow`,
  and every integration pointer's external twin is the same README's
  `#integrator-guide` anchor, the one the root README's own Integration
  guide section links onward to.
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

1. Step-pattern refactor of the deposit pair: the diagram trim + caption
   respell, then the page restructure + heading/note respell.
2. C1 checks 1, 2 and 4 over the flow pages. Plant a violation, watch it
   fail, restore.
3. Derivation story upgrade: the actor map item first, then the deposit
   inherit item, deciding the vault-to-singleton gap item alongside it.
4. Withdraw diagram, then the withdraw page, then C1 checks 3, 5 and 6.
5. Swap, supply and redeem, each as diagram then page (diagrams may run in
   parallel across flows). C3 rules.
6. C2 CI wiring.
7. C5 integration repo PR.
8. The two vault README follow-ups (e2e numbers from an executed run, the
   re-homed real-network guidance), schedulable any time.
