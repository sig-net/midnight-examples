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
- [x] Actor map working size settled: the completed anatomy measures
      1695x1260 model units against the style guide's roughly 1300x800
      budget, and the guide says outgrowing diagrams split rather than
      squeeze. The all-17 decision forces the overrun, so decide ONCE:
      accept the actor map as the one sanctioned exception (record it in
      docs/diagramming.md's working-size section), or split/regroup the
      anatomy. Judge against the vault README's rendered embed legibility
      at README column width before deciding.
      DONE, settled by the user and recorded in docs/diagramming.md's
      working-size section, with the premise reframed: the budget is
      ADVISORY, not a rule that a diagram may exception itself out of.
      An overrun the binding rules force is accepted as it stands, and
      the actor map's full-anatomy mandate forcing 1695x1260 is named
      there as the case in point. An overrun nothing forces is slack
      with three exits (tighten, split, or move sequencing to mermaid).
      The ban on squeezing (fonts, resolution) stays binding, as does
      the golden precedence that clarity rules outrank the budget. The
      lint tool enforces no size budget, so no tooling change followed.

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
- [x] Palette follow-up, one quiet change, parallel-safe with every
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
      DONE: id `2` was referenced nowhere else in the palette (zero
      `parent`, `source`, `target` or any other `="2"` attribute in the
      file), so the rename to `secret-node-icon` closed with the cell
      itself, and the sibling text cell `secret-node-text` already set
      that naming. The repo-wide grep for `eye-icon` returned four hits:
      the iconography table row in docs/diagramming.md (moved to
      `diagram-assets/secret-icon.png`), the palette cell whose id
      encoded the bank filename, `icon-eye-icon.png` (renamed to
      `icono-secret-icon`, matching its row siblings
      `icono-ledger-icon`, `icono-circuit-icon`, `icono-witness-icon`
      rather than re-encoding a filename in an id), and two lines of
      this task's own description, which stay as written. No .drawio
      references the bank path: every icon is an embedded payload, as
      predicted. The bank file moved with `git mv`. The palette diff
      against HEAD is exactly two changed lines, id attribute only,
      with both `style` strings (34069 chars each) byte-identical, so
      no payload moved. Lint --strict output is byte-identical to
      linting the pre-change file from HEAD (0 errors, 0 warnings, the
      same stacked-run and vacuous-check notes, and no
      floating-connection advisory fires on this version at all), the
      cell table is unchanged at 86 rows with identical geometry and
      parents, and the PNG round-trip carries both new ids and zero
      occurrences of the old names. Rendered from source through the
      root config, eyeballed downscaled plus full-resolution crops of
      the EXAMPLE_SECRET card and the contract-members icon row: both
      crossed-eye icons render intact.
- [x] Palette gains an "Edge labels" card: byte-copy sources for the
      strict label format, requested by the repo owner alongside the
      caption abolition. The six phase-legend swatches stay as the colour
      legend (their captions name the styles, the specimen exemption
      covering them is correct), and two new specimens carry the format
      itself: a horizontal-run swatch with the riding label "MPC: Reads
      the recorded request" (`align=left`, offset seating the left-
      anchored label so the run crosses its text centre) and a vertical-
      run swatch with "dApp/relayer: Broadcasts the MPC-signed
      transaction" (`align=center`), ids `edge-label-*`, degenerate
      endpoints matching the swatch construction. The strict-label-format
      bullet in docs/diagramming.md now names the card as the label
      cell's copy source. Lint --strict 0/0 with the specimen exemption
      absorbing both labels (legend caption count 7 to 9, notes otherwise
      identical to pre-change), palette diff purely additive, render
      eyeballed with a crop of the new card.
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
- [x] Witness icon swept through the diagrams: SUPERSEDED by the
      per-diagram conformance rework tasks in the Step-pattern refactor
      section, which carry the swap one diagram at a time (the split is
      sanctioned there). This entry stays only so the sweep's history has
      a home: no work happens under it.
      DONE, supersession confirmed by execution, not by the tick marks
      alone: every committed diagram carrying a witness member row
      (actor map, deposit, withdraw, swap) holds a `code-witness-icon`
      whose style attribute hashes byte-identical to the palette's
      `icono-witness-icon` copy source, the embedded payload sha256-
      matches `docs/diagram-assets/witness-icon.png`, and the decoded
      image reads as the open eye. The generic pair carries zero
      witness cells, so it owes no swap. No cog remains anywhere a
      witness is drawn: the sweep this entry once described has no
      remaining work.
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
- [x] `docs/withdraw/withdraw.md`: flow page over the frozen strings. Start
      the prose from the withdraw deep-dive at
      `git show beeb8f3:examples/erc20-vault/README.md` (section "Runtime:
      the other circuits"), not from scratch.
      DONE: page written to deposit.md's shape (protocol / integration
      pointer sections, PNG embed, actor paragraph, section per step,
      shared vault and reader setup, mermaid, footer). Seeded from the
      `beeb8f3` "Withdraw (`withdraw` / `completeWithdraw` / `refund`)"
      subsection: its deposit-versus-withdraw comparison table is dissolved
      into the step prose (the page stands alone rather than as a diff
      against deposit), and its two pattern bullets (coin-spend as
      authorisation, settle branches on the attested output width) become
      the step 1 and step 5 narratives. All six canonical strings carried
      byte-equal, each once as an `^### Step \d+:` heading and once on a
      `Note over` line, the two step 5 arms sitting in a mermaid
      `alt`/`else`. Correspondence verified: 1 heading + 1 mermaid note per
      string on the page, 1 hit per string in `withdraw.drawio`, and
      `withdraw` / `completeWithdraw` / `refund` each grep as
      `export circuit` in the compact source. README's three
      `docs/withdraw/withdraw.md` circuit-table links (plus the flows list
      and its intro) carry no fragments and resolve to the new file.
      `yarn format:check` green from the root.
      Corrected against the code while reworking the seed: the seed's
      `deriveEvmAddress(mpcRootPublicKey, vaultContractAddress, "vault")`
      is the bare literal, while `integration-tests/src/setup.ts` and the
      vault README both derive from `VAULT_PATH_HEX`, the full-width
      lowercase hex of `pad(32, "vault")`, so the setup snippet shows the
      hex rendering. Dropped from the seed: the swap subsection (its own
      task), and the notification's `requestsPathDepth`, which the withdraw
      circuit passes as `2` with the e2e suite asserting `[0, 0]` while its
      neighbouring comment says depth 1, so the page says only that the
      circuit notifies the MPC through the singleton.
- [x] Flow-page style ruled: pages are DESCRIPTIONS, not code walkthroughs.
      The golden specimen is the five-step list under the diagram in the
      integration repo README's Sign Bidirectional Flow section: one flat
      `- **N.**` dash-bullet list (bold manual ordinals so renderers keep
      the two-space nesting), detail bullets laying out the mechanism with
      links replacing quotation, snippets defaulting to ZERO with the
      specific-point exception. Recorded as docs/flow-pages.md, bound from
      AGENTS.md's Flow pages section (root-bound on purpose: a docs/-scoped
      agents file would not load for pages under examples/*/docs). The
      correspondence contract's page renderings are amended above to the
      bullet + mermaid pair.
- [x] `docs/deposit/deposit.md` restyled to the golden step list: the six
      `### Step N:` sections and all seven snippets dissolved into the flat
      bullet list, load-bearing facts carried as linked detail bullets,
      three stale claims dropped against the source (`requestsPathDepth`
      shown as 1 where the circuit passes 2, an outdated claim-gate shape,
      ledger path `[0]` where `VAULT_REQUESTS_PATH` is `[0, 0]`).
      Correspondence green under the amended contract (6 bullets, 6 mermaid
      notes, 0 step headings), links and line anchors verified, root
      format:check green. Inbound `deposit.md#` fragments are gone
      repo-wide, and the vault README's two stale wordings promising
      snippets and full code respelled by the orchestrator, who also fixed
      the three dead `#sign-bidirectional-flow` fragments (the root README
      heading renders as `#sign-bidirectional-protocol-flow`).
- [x] `docs/withdraw/withdraw.md` restyled the same way in the same round:
      six-bullet list (two `- **5.**` arms), zero snippets, mermaid block
      byte-identical, fragment links into deposit.md rewritten fragment-free
      ahead of that page's heading removal, all 30 links resolving, root
      format:check green.
- [x] Actor map `n-read` truth fix (owner decision: the diagrams exist to
      name the specific state, so the note must name the true ledger map):
      the membership rule's new `n-read` exemption applied to
      `docs/actor-map.drawio(.png)`: the note's `From:` line lists every
      request event map in the anatomy (`signBidirectionalEventMap`,
      `swapEventMap`, `supplyEventMap`, `redeemEventMap`), each bold, one
      per line, box re-hugged, lint, render, eyeball. Flow copies narrow
      to their own maps under the exemption, so no flow re-sync follows.
      DONE: value changed to the four-map From block (`From:` on its own
      line, the shape the membership rule now spells out for the
      multi-map case, single-map copies keeping the name on the From
      line), box re-hugged 208x60 to 170x117, `n-sign` and `n-attest`
      pushed down on the 30-unit rhythm and the MPC lane grown to keep
      its bottom padding, no edges anchored to the moved notes so
      nothing re-routed. All four names grep as the map's own ledger
      rows, and the settle-view commitment maps are correctly absent.
      Lint byte-identical to HEAD, phase-stroke zero-hit, render
      eyeballed on the note-column crop. The MPC lane keeps its width
      although the narrowed note leaves 51 units of right padding: the
      flow copies carry wider single-name notes, and a shared lane width
      keeps the family reading as one, within the lane-width rule's
      minimum-padding bound.
- [x] Full arrow-description pass, deposit diagram: the every-step-arrow-
      describes-itself rule applied to `docs/deposit/deposit.drawio(.png)`:
      every logical step arrow gains an acting-party label (the wallet's
      circuit calls, the circuit-to-circuit call, the MPC's post edges),
      existing labels kept, verb table extended as needed, full
      verification cycle with the `n-read` exemption.
      DONE: five labels added, so all thirteen logical step arrows carry
      a description or a recorded exemption (the `e3b` code label, and
      `e2c`, the intra-lane continuation of the MPC's read-sign-post
      thread). New values: "User's Midnight wallet: Submits the ERC20
      address and amount to deposit(...)" (respelling to Starts queued in
      the harmonisation pass below), "deposit circuit: Calls the
      singleton to notify the MPC", "MPC: Posts the signature", "MPC:
      Posts the attestation", "User's Midnight wallet: Submits the
      attested event and output to claim(...)". Seating grew the model
      1594 to 1934 wide under the golden precedence (left corridor
      unpacked, vault-to-singleton and Midnight-to-MPC gaps widened),
      existing labels keeping their anchors. Verified: lint --strict 0/0
      with three notes read and explained (two pre-existing anchor-caused
      stacks, one estimate false-positive disproven by pixel crop, one
      pre-existing note gone), membership zero over 109 cells under the
      n-read exemption with three planted violations failing the guard,
      ordinals 1 to 6, phase-stroke zero-hit, round-trip carrying all
      five values, renders eyeballed per label.
- [x] Full arrow-description pass, withdraw diagram (parallel): same rule
      over withdraw's arrows, same verification.
      DONE: ten new labels land, so all thirteen logical step arrows now
      carry a description or a recorded exemption (the `e3b` code label,
      and `e2c`, the 30-unit intra-lane thread between two
      self-describing MPC notes). Deposit's wordings reused verbatim for
      the shared constructs (Reads, both Picks up labels, transaction
      execution), withdraw-specific ones composed from the verb table
      ("User: Starts withdraw(...) surrendering a vault coin", "withdraw
      circuit: Calls signBidirectional(...)", "MPC: Posts the signature"
      and "Posts the attestation", "dApp/relayer: Broadcasts the
      MPC-signed transfer", "User: Submits completeWithdraw(...)"). The
      Starts verb row widened to "dApp/relayer, User" by the
      orchestrator. Seating the labels legally grew the model 1674 to
      1968 wide under the golden precedence (the vault-to-singleton gap
      to 264 for the Calls label, the Midnight/MPC corridor to 120), and
      the re-seat fixed the long-standing e4a/c2 clip (c2 clear by 54
      units), retiring that follow-up. Verified: lint --strict clean
      with the one pre-existing anchor-caused note, membership zero over
      119 cells under the n-read exemption (the note names exactly
      signBidirectionalEventMap, withdraw's only request event map),
      eight planted violation kinds each failed the guard including the
      blind-input case, ordinals 1 2 3 4 5 5, phase-stroke zero-hit,
      render eyeballed with crops of every new label, PNG round-trip
      carrying all ten strings. The width growth deepens the
      working-size overrun already queued as its own decision task.
- [x] Full arrow-description pass, swap diagram (parallel): same rule over
      swap's arrows, plus its `n-read` note narrowed to the two maps its
      box carries (`signBidirectionalEventMap` for the approve leg,
      `swapEventMap` for the swap request), same verification.
      DONE: nine labels added, thirteen of fourteen step arrows labelled
      and the fourteenth the recorded intra-lane continuation, wordings
      matching the siblings for shared constructs. The `n-read` note
      narrowed to its box's two maps in the box's own row order
      (`swapEventMap` then `signBidirectionalEventMap`: the exemption
      binds the names to the box, and box order is the honest listing),
      box re-hugged and the note column re-seated on the 30-unit rhythm.
      The gutter re-columned and the left column moved out so every
      label rides a run that reads, the model growing to 1944x1397.
      Verified: lint --strict 0/0 with two label-box notes disproven by
      pixel scan (the tool centres an align=left box the renderer
      left-anchors: already queued in the tool harvest), membership zero
      over 129 cells under the exemption with five planted violations
      failing the guard, phase-stroke zero-hit proven non-vacuous,
      ordinals {1,2,3,4,5,6,6}, every bold name grepping in source,
      round-trip carrying all fourteen strings. Its proposal to widen
      the Submits meaning is declined: entry calls take Starts in the
      harmonisation pass below, and Submits keeps its settle/complete
      qualifier. Cosmetic residue flagged: two labels knock a short gap
      into a lane border they cross, accepted over cascading the right
      half.
- [x] Label harmonisation micro-pass across the three flow diagrams
      (after all three arrow passes land): the parallel passes diverged
      on two spellings, and one verb one meaning settles both. Entry-
      circuit calls use `Starts` (deposit's `e1a-l` respells from its
      Submits form, keeping its cargo: the settle calls keep `Submits`,
      whose meaning stays "to settle or complete"), and wallet-driven
      edges name the acting wallet, `User's Midnight wallet:` (matching
      `User's EVM wallet:` on the fund edge), so withdraw's `e1a-l`,
      `e5a-l` and `e5b-l` respell their bare `User:` prefix, plus swap's
      equivalents once its pass lands. Re-seat any label whose width
      changes, re-render all touched pairs, lint, membership, eyeball.
      DONE: eight labels respelled across the three diagrams, each
      edge's `mid-wallet` source confirmed before its prefix changed.
      Zero seats moved: a pixel diff of pre- against post-change renders
      proved every label's footprint unchanged or narrower (the bold
      wallet prefix renders no wider than each label's longest body
      line, and Starts is shorter than Submits), so no gap grew and no
      geometry was touched. Cross-family grep: zero bare User: prefixes
      remain, Starts sits on exactly the four entry calls, Submits only
      on the settle calls. Lint --strict 0/0 on all three with note sets
      identical to pre-change, membership proofs unchanged at zero (the
      respelled ids are all step layer), round-trips byte-identical,
      renders eyeballed per label. No verb-table change was needed.
- [x] Curved step corners ruled (owner decision, seeded by the hand-drawn
      generic): every coloured step edge turns its corners as arcs,
      `rounded=1;arcSize=20`, so the step lines pop from the rectangular
      structure. Derivation edges, lane borders and shapes keep sharp
      right angles, and runs stay strictly orthogonal in both cases. The
      six palette phase swatches carry the tokens as the copy source
      (flipped, re-rendered, lint 0/0), the edge-routing rules in
      docs/diagramming.md and the AGENTS.md corner wording amended.
- [x] Curved-corner sweep, generic pair: flip every phase-stroked step
      edge in `docs/sign-bidirectional-flow.drawio(.png)` to the palette's
      corner tokens, re-render, verify, then mirror the finished pair
      byte-identically into the integration repo checkout's docs/ (the
      two sources are byte-identical today and stay in lockstep,
      uncommitted there).
      DONE: all 18 edges flipped (the generic carries no derivation
      edges: its broad-dashed cells are note text shapes), proven
      token-only by reverting the tokens and recovering the pre-change
      bytes byte-for-byte. Lint --strict output identical to baseline,
      render eyeballed with corner crops: coloured corners arc, all
      structure sharp, the one 38-unit orange S-bend reads as a smooth
      deliberate S and stands. Mirror landed after an md5 pre-check
      (both sources were byte-identical), both files verified identical
      in the integration checkout and left uncommitted there.
- [x] Curved-corner sweep, deposit diagram (parallel).
      DONE: 13 step edges flipped, jump hops preserved, the whole-file
      diff proving 13 token-only line changes. Two-way completeness
      clean (the six phase-coloured step circles and all 8 derivation
      edges correctly untouched), lint byte-identical to baseline,
      membership zero before and after with a planted violation caught,
      no label slides needed (every knockout keeps ample straight
      lead-in), render eyeballed: arcs clean, the tightest 33-unit
      S-curve intact, the dense relayer corner cluster legible.
- [x] Curved-corner sweep, withdraw diagram (parallel).
      DONE: 13 step edges flipped, 8 derivation edges sharp, cell-level
      diff showing exactly 13 style-only changes. Lint byte-identical
      (the one stacked-run note re-confirmed anchor-caused), membership
      zero before and after with two planted violations caught including
      the exact risk of this task (a shared derivation edge flipped
      curved). Measure-diff of all 12 labels proved no seat moved, and
      the analytic bound holds (shortest segment 42 units against the
      20-unit arc radius). Render eyeballed: the purple fan-out renders
      as parallel arcs, dashed corners sharp against the curving colour.
- [x] Curved-corner sweep, swap diagram (parallel). The actor map is
      exempt: it carries only derivation edges, which stay sharp.
      DONE: 14 step edges flipped with the byte-level proof (reverting
      the tokens recovers the pre-change file exactly, delta 14 x 11
      chars), the 7 phase-coloured step circles and every derivation
      edge untouched, jump hops surviving. Lint byte-identical (its two
      label-box notes re-read and confirmed as the sanctioned T-junction
      fan-outs), membership zero before and after with three planted
      violations caught and values compared entity-decoded (the actor
      map spells apostrophes as entities where swap is literal, a
      serialiser artefact). No label slides needed. Render eyeballed:
      the tight green turn into the router clamps to a clean small arc,
      the U under the EVM lane keeps its code label centred between two
      arcs.
- [x] Step-caption sweep, deposit diagram: the caption abolition (the
      correspondence contract above and the style guide's every-text-on-an-
      arrow-is-an-edge-label rule) applied to
      `docs/deposit/deposit.drawio(.png)`: the six `stepN-label` cells
      deleted with their space reclaimed, each step's salient edge carrying
      an acting-party riding label where the step's action deserves text
      (verb table extended one row per new verb as needed), circles'
      ordinal set verified against the frozen strings, full verification
      cycle with membership proof at zero.
      DONE: six captions deleted, and the only two labels added sit on
      the arrows whose bare endpoints actively misled (a dApp-to-circuit
      arrow reads as a call when the dApp is watching emitted events):
      `b2-l` "dApp/relayer: Picks up SignatureRespondedEvent" and `o4-l`
      "dApp/relayer: Picks up RespondBidirectionalEvent". The Picks up
      verb row widened to "MPC, dApp/relayer" by the orchestrator. The
      restraint cases (wallet-to-circuit call arrows, the
      circuit-to-circuit call) gained nothing: circuit behaviour lives in
      the circuit's own box. Five circles re-seated onto their own step's
      edge at touching distance, `c2` already there. Verified: no cell
      text matches "Step N:", ordinals exactly 1 to 6, lint --strict
      clean with the same three anchor-caused notes as the pre-edit
      baseline, membership zero over 109 background cells with the guard
      proven failing on four planted violation kinds, phase-stroke
      zero-hit, render eyeballed with crops of every vacated region. The
      whitespace pocket right of circle 5 is structural routing corridor,
      present before the sweep.
- [x] Step-caption sweep, withdraw diagram (parallel with deposit): the
      six `stepN-label` cells deleted the same way, one numbered circle
      per settle arm retained, same label, ordinal and verification
      requirements.
      DONE: six captions deleted and the vacated settle band re-used
      rather than left dead: the refund arm split off the shared settle
      vertical onto its own x=240 run through the band, `c5b` re-seated
      to hug it, and the one place a caption held unrecoverable meaning
      (the refund arm's branch condition) became the diagram's sole new
      riding label, "User: Submits refund(...) when the transfer never
      executed". The Submits verb row widened to "dApp/relayer, User" by
      the orchestrator (the settle circuits are caller-driven). Circles
      carry the ordinal multiset 1 2 3 4 5 5, no cell text matches
      "Step N:", lint --strict clean with the same single anchor-caused
      note, membership zero over 117 background cells with the guard
      rebuilt id-based after its colour-based strip proved vacuous on a
      plant, phase-stroke zero-hit, render eyeballed with crops of every
      vacated spot. The pre-existing e4a/c2 clip is untouched.
- [x] `docs/swap/swap.drawio(.png)`: canonical strings frozen first, then the
      diagram (approveRouter precursor, swap / completeSwap), built caption-
      free under the amended rules (numbered circles and edge labels only).
      DONE: six strings frozen in the correspondence section, then the pair
      built and rendered. Derivation of the strings: the phase skeleton with
      no fund step (the swapper surrenders a shielded coin), the
      `approveRouter` precursor numbered step 1 as deposit numbers its own
      precondition leg, and the settle branch sharing ordinal 6 the way the
      contract's `Runtime step 5 (withdraw/swap/supply/redeem): refund`
      header shares withdraw's. Verb phrases came from the `beeb8f3` swap
      deep-dive, the two poll steps reuse deposit's wording verbatim, and
      the broadcast step names the swap.
      Decision recorded, the reviewable one: the precursor takes step 1 and
      the round trip runs 2 to 6, so swap's settle ordinal is 6 while the
      contract's shared refund header still says 5. The alternative (leaving
      the precursor outside the ordinals) has no caption-free way to mark
      the leg, since every step-layer marker is a numbered circle. The
      contract-marker renumber item below now covers swap as well as
      deposit.
      Membership, read from `erc20-vault.compact` plus `flows/swap.ts` and
      `flows/approve.ts`: ten ledger rows (`signetRequestNonce`,
      `initialized`, `evmChainId`, `caip2Id`, `uniswapRouter`,
      `swapRefundCommitment`, `swapEventMap`, `mpcResponseKey`,
      `signBidirectionalEventMap`, `vaultEvmAddress`), `callerSecretKey`,
      and four circuits (`approveRouter`, `swap`, `completeSwap`, `refund`).
      `signBidirectionalEventMap` is in for the approve leg, which records
      there, and `swapEventMap` for the swap leg. `swapRefundCommitment`
      joins on the withdraw precedent, where `refundCommitment` counts as
      interacted-with through the circuits rather than the flow files.
      Construction: copied from `withdraw.drawio` (itself a proven copy of
      the map) and the six added members byte-copied from the actor map,
      which the proof then re-checks cell by cell against the map. The four
      derivation-bus edges the map gained (`dvaddr-respkey`, `dvaddr-vault`,
      `dvaddr-acct`, `dmpc-acct`) stay off, exactly as deposit's and
      withdraw's diagrams leave them off, and the subset direction allows
      it.
      Geometry: one column of sixteen rows, ledger / witness / circuits with
      the 70 section gap and 14 row gap, the vault lane grown to 945 and
      seated evenly (20/20) in its parent's interior band, the singleton
      lane dropped 162 so `signBidirectional` stays level with `swap`, and
      the EVM lane plus `n-acct` moved 162 down so the run band under the
      Midnight lane keeps its 30-unit rhythm. Steps 1 and 2 share one red
      trunk out of the Midnight wallet with a T at each circuit, the settle
      pair shares the purple trunk as in withdraw, and no two edges of one
      colour cross.
      Verification: `lint --strict` 0 errors (two notes, both confirmed
      anchor-caused: `g3`'s column is fixed by the 40-unit lead into the
      router's left face, which cannot align with `d2`'s or `b2`'s without
      cutting `erc20-token`), membership proof PASS over 129 background
      cells with the colour-defined and id-defined step layers coinciding,
      phase-stroke grep zero over the written-out stripped background,
      circles carrying exactly {1,2,3,4,5,6,6}, PNG round-trip 154 cells
      identical, and crops read for every label and circle.
      Open question for review: `n-read` says `From: signBidirectionalEventMap`
      while step 3's read edge lands on `swapEventMap`, which is where a
      swap request lives. The note is background and byte-frozen, so the
      diagram inherits the mismatch. Supply and redeem hit the same thing.
- [x] `docs/swap/swap.md`: flow page over the frozen strings, per the
      flow-pages style guide (golden step list, zero snippets). The same
      `beeb8f3` section carries the swap prose to start from.
      DONE: 312 lines, the withdraw page's five-section shape with the
      shared-ordinal settle branch handled its way. Correspondence
      verified both directions (bullets reconstruct the seven frozen
      strings byte-equal, Note over lines carry them verbatim), ordinal
      multiset {1,2,3,4,5,6,6} matching the diagram's circles, all four
      circuit names grep as `export circuit`, 46 relative links resolve
      with every #L anchor checked against its declaration, zero
      snippets, prettier clean. Where beeb8f3 and code disagreed, code
      won: swap's attestation poll is `swap.ts`'s own
      `fetchSwapOutcome`/`pollSwapOutcome` (the shared
      poll-respond-bidirectional helper is deposit/withdraw-only), the
      separate-map rationale names the schema widths too, and the page
      names `VAULT_SWAP_REQUESTS_PATH` instead of quoting the numeric
      ledger-tree path, since `vault-context.ts`'s docstring (`[11]`)
      and `contract/src/index.ts` (`[1, 7]`) disagree. Bonus finding:
      swap's inherited `n-read` two-map pairing is genuinely correct for
      this flow (the approve leg records in the field-0 map), and the
      page says the same in prose.
- [x] `docs/supply/supply.drawio(.png)`: canonical strings frozen first, then
      the diagram (approveStata precursor, supply / completeSupply), built
      caption-free under the amended rules.
      DONE: seven strings frozen in the correspondence section (wording
      from the contract's own circuit headers, no README covers supply),
      then the pair built from swap's proven copy. Membership: eleven
      ledger rows (swap's shared nine minus the router and swap maps,
      plus `stataUnderlying`, `stataToken`, `supplyEventMap`,
      `supplyRefundCommitment`), `callerSecretKey`, four circuits
      (`approveStata`, `supply`, `completeSupply`, `refund`), evidence
      per member from the circuit bodies and `flows/supply.ts` /
      `flows/approve-stata.ts`. `n-read`'s sanctioned delta names
      `supplyEventMap` then `signBidirectionalEventMap`. Geometry: the
      16-row column grows the vault lane 42 units over swap with the
      band rhythm preserved, and the one reviewable deviation is
      geometry-only: `stata-token` and `uniswap-router` swap x slots so
      the broadcast target sits left of `acct-vault`, sparing the
      byte-frozen `d2` a crossing. `g3`, `o4` and `e1b` carry arc jumps
      so all 16 cross-colour crossings hop (swap leaves two as plain
      junctions). Verified: lint --strict 0/0 with the one o4/c4
      clearance note anchor-caused as in swap, membership proof PASS
      over 135 background cells with five planted violation kinds
      caught (the colour-defined strip scoped to stroke/font after
      `user-person`'s fill matched a phase hex), phase-stroke grep
      zero, circles exactly {1,2,3,4,5,6,6}, PNG round trip 169 cells
      identical, zero same-colour crossings, every label with visible
      run both sides (minimum 27.7u), render eyeballed by the builder
      and the orchestrator. Known artefact carried: the actor map
      spells apostrophes as entities where the copies are literal,
      compared entity-decoded as in swap.
- [x] `docs/supply/supply.md`: flow page over the frozen strings, per the
      flow-pages style guide (golden step list, zero snippets). No README
      coverage exists for supply: written fresh from the contract and
      `integration-tests/src/flows/`.
      DONE: written fresh from the circuit headers and flow files, same
      five-section shape, correspondence verified both directions
      against the frozen strings, ordinals {1,2,3,4,5,6,6}, all 34
      links resolving with anchors checked (the sibling PNG landed
      after the page and now resolves), zero snippets. Supply owns its
      poll loop as swap does (`fetchSupplyOutcome` inside `supply.ts`),
      and the page states the field-15 vs ledger-tree-path `[1, 11]`
      distinction explicitly. Follow-up flagged for a separate change:
      `broadcast-evm.ts`'s `tolerateRevert` JSDoc names only swap while
      supply and redeem pass it too.
- [x] `docs/redeem/redeem.drawio(.png)`: canonical strings frozen first, then
      the diagram (redeem / completeRedeem), built caption-free under the
      amended rules.
      DONE: six strings frozen in the correspondence section (redeem has
      no fund step AND no approve precursor, the vault redeems its own
      shares, so the flow takes withdraw's skeleton and its settle
      ordinal 5 agrees literally with the contract's shared refund
      header), then the pair built from supply's copy, chosen since
      supply already carries the Aave background byte-frozen. Membership:
      ten ledger rows (supply's minus `signBidirectionalEventMap`,
      proven OUT by a whole-contract use census showing zero hits inside
      the redeem/completeRedeem block, with `redeemEventMap` and
      `redeemRefundCommitment` in), `callerSecretKey`, three circuits.
      `refund`'s unconditional routing probes of the three foreign
      marker maps stay out on supply's precedent. `n-read`'s sanctioned
      delta is the single-map form naming `redeemEventMap`, the box
      re-hugged 170x90 to 154x60 matching `n-attest`. Geometry: all 120
      vacated units left the diagram (bounds 1944x1447 to 1944x1327),
      `redeemEventMap` seated between `mpcResponseKey` and
      `vaultEvmAddress` so the pinned keyDerivation notes keep their
      spacing, and the singleton lane rose so its three circuits pair
      row-aligned with the vault's three. Verified: lint --strict 0/0
      with the one o4 clearance note anchor-caused as in supply,
      membership proof PASS over 127 background cells with six planted
      violation kinds caught, phase-stroke zero after scoping to
      stroke/font, circles exactly {1,2,3,4,5,5}, PNG round trip 158
      cells identical, 0 same-colour crossings and all 16 cross-colour
      crossings jumped, render eyeballed by builder and orchestrator.
      Judgement call recorded: `e1a` keeps the siblings' generic
      "surrendering a vault coin" wording rather than naming the
      stataToken colour.
- [x] `docs/redeem/redeem.md`: flow page over the frozen strings, per the
      flow-pages style guide (golden step list, zero snippets). Written
      fresh, as for supply.
      DONE: written fresh from the circuit headers and `flows/redeem.ts`,
      withdraw's five-section shape with the shared-ordinal branch
      phrased its way. Correspondence verified both directions against
      the frozen strings, ordinals {1,2,3,4,5,5} matching the diagram's
      circles, all three circuit names grep as `export circuit`, every
      relative link and all 23 #L anchors land on the intended
      declarations, zero snippets. Substance: the shares-vs-assets
      distinction carries the page's key point (the wrapper's exchange
      rate accrues Aave interest, so only the executed call knows the
      payout, which is why settle takes the attested output), the
      refund bullet uses `RedeemSettleView`'s real field name `shares`
      where supply's view says `amount`, and the flow-function vs
      circuit name collision on `completeRedeem` is kept apart by
      linking each occurrence to its own file. Footer nav closes the
      chain with Previous: Supply.

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

Every canonical step string renders exactly twice, both on the flow page: as
its step-list bullet (`- **N.** <tail>`, the tail being the string after
`Step N: `) and on a mermaid `Note over` line carrying the full string. The
flow diagram carries NO step text: its numbered circles are exactly the frozen
strings' ordinals (a branch's arms share one ordinal, one circle per arm), and
every bit of text on or beside an arrow is an edge label under the style
guide's golden rules (bold acting party, colon, verb-led body), never a
free-standing caption. One vocabulary, two renderings, per flow page.

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
each arm's string still renders twice on the page (two `- **5.**` bullets
each satisfy check 1 on their own), with one numbered circle per arm on the
diagram.

**Canonical step strings, swap** (frozen). Swap has no fund step: the swapper
surrenders a shielded coin instead of moving EVM value out of their own wallet.
Step 1 is the `approveRouter` precursor, the sign-only allowance leg
`runSwapRoundTrip` runs first through `ensureRouterApproved`, numbered exactly
as deposit numbers its own precondition leg (funding), so the swap round trip
runs steps 2 to 6. The settle is a branch whose two arms share ordinal 6, the
sharing the contract itself records (`Runtime step 5
(withdraw/swap/supply/redeem): refund`), at 6 rather than 5 as the precursor
takes step 1. Wording from the vault README's swap deep-dive (`git show
beeb8f3:examples/erc20-vault/README.md`, section "Swap") under truth priority:

1. `Step 1: approveRouter(...) records the sign-only allowance request`
2. `Step 2: swap(...) burns the surrendered coin and records the request`
3. `Step 3: poll for the MPC's signature`
4. `Step 4: broadcast the swap to the EVM chain`
5. `Step 5: poll for the MPC's attestation`
6. `Step 6: completeSwap(...) mints amountOut of tokenOut plus the unspent tokenIn`
7. `Step 6: refund(...) re-mints when the swap never executed`

**Canonical step strings, supply** (frozen). Supply has no fund step: the
supplier surrenders a shielded coin of the underlying. Step 1 is the
`approveStata` precursor (the sign-only allowance leg `runSupplyRoundTrip`
runs first through `ensureStataApproved`), numbered exactly as swap numbers
`approveRouter`, so the supply round trip runs steps 2 to 6 and the settle
branch's arms share ordinal 6 (the sharing the contract records in its
`Runtime step 5 (withdraw/swap/supply/redeem): refund` header). No README
deep-dive covers supply, so wording comes from the contract source's own
circuit headers under truth priority (code first), with the two poll steps
reusing the deposit wording verbatim and step 2 keeping the
withdraw-and-swap burn-and-record shape:

1. `Step 1: approveStata(...) records the sign-only allowance request`
2. `Step 2: supply(...) burns the surrendered coin and records the request`
3. `Step 3: poll for the MPC's signature`
4. `Step 4: broadcast the supply to the EVM chain`
5. `Step 5: poll for the MPC's attestation`
6. `Step 6: completeSupply(...) mints shielded(stataToken) for the attested shares`
7. `Step 6: refund(...) re-mints when the supply never executed`

**Canonical step strings, redeem** (frozen). Redeem has no fund step and no
approve precursor: the vault redeems its OWN shares (owner = vault, per
`flows/redeem.ts`), so no allowance leg exists and the flow follows
withdraw's skeleton, request through settle numbered 1 to 5 with the settle
branch's arms sharing ordinal 5, matching the contract's
`Runtime step 5 (withdraw/swap/supply/redeem): refund` header directly. No
README deep-dive covers redeem, so wording comes from the contract source's
own circuit headers under truth priority (code first), the two poll steps
verbatim from deposit and step 1 keeping the burn-and-record shape:

1. `Step 1: redeem(...) burns the surrendered coin and records the request`
2. `Step 2: poll for the MPC's signature`
3. `Step 3: broadcast the redeem to the EVM chain`
4. `Step 4: poll for the MPC's attestation`
5. `Step 5: completeRedeem(...) mints shielded(stataUnderlying) for the attested assets`
6. `Step 5: refund(...) re-mints when the redeem never executed`

**The six checks** (C1 implements, per flow page):

1. Collect every step-list bullet matching `^- \*\*\d+\.\*\* ` in each
   `examples/*/docs/*/*.md` flow page, reading each as ordinal + tail. Assert
   the set is non-empty per page (a structurally blinded guard must fail
   loudly).
2. For each collected bullet, the full string `Step <ordinal>: <tail>` appears
   verbatim on a `Note over` line inside a ` ```mermaid ` block on the same
   page.
3. The sibling `<flow>.drawio` source in the page's folder contains no cell
   text matching `Step \d+:`, and its numbered step circles carry exactly the
   bullets' ordinal multiset (one circle per branch arm).
4. Every circuit name in a step string exists as `export circuit <name>` in the
   example's `.compact` source.
5. `extract` each committed `.drawio.png` and assert the embedded cells match
   the committed `.drawio` beside it. Cell-level comparison ONLY, never a byte
   `diff` (the webapp re-serialises the embedded model).
6. Strip each flow diagram's step layer and assert every remaining cell
   matches the actor map's cell of the same id on id, value and style
   (geometry excluded), and that the remaining id set is a subset of the
   actor map's. One sanctioned value delta: the `n-read` note's `From:`
   line names the request event map(s) present in that diagram's own
   contract box (the membership rule in docs/diagramming.md), checked
   against the diagram's map rows rather than the actor map's value.

## Tool harvest checklist (draw-io-cli)

**Context for the dependency-upgrade items below** (each stands alone, and a
fresh agent needs only this file). The tool is the `drawio-cli` Node CLI in
the `BRBussy/draw-io-cli` repo, checked out at
`/Users/bernard/Projects/github.com/BRBussy/draw-io-cli` (local checkouts
mirror `github.com/<org>/<repo>`). Plain npm with a committed
`package-lock.json`, `"type": "module"`, source under `src/` (`cli.js`,
`lint.js`, `measure.js`, `cells.js`, `edit.js`, `diff.js`, `extract.js`,
`render.js`, `png.js`, `webapp.js`, `config.js`, `doctor.js`). It carries
exactly ONE runtime dependency today, `playwright` pinned to the exact
version `1.62.1`: keep that leanness deliberate, add a dependency only when
the item below names it, pin it EXACTLY
(`npm install <pkg>@<version> --save-exact`, version resolved first via
`npm view <pkg> version`, never a floating range, never a global install),
and confirm the release is not deprecated. Verification for every item:
`npm test` from the repo root (the smoke suite, which renders through the
hediet.vscode-drawio extension's webapp under playwright Chromium: run
`node src/cli.js doctor` first if unsure the render path is present) and
`node test/lint-violations.mjs` (the planted-violation suite) must both
pass, and `node src/cli.js lint <pair> --strict` must stay at 0 errors and
0 warnings for every committed pair in THIS repo:
`docs/sign-bidirectional-flow.drawio`, `docs/diagram-palette.drawio`,
`examples/erc20-vault/docs/actor-map.drawio` and the three
`examples/erc20-vault/docs/<flow>/<flow>.drawio` flow diagrams (deposit,
withdraw, swap). Behaviour must not change: these are drop-in replacements
of hand-rolled plumbing, and any output difference is a defect unless an
item names it. After a change to any check, plant a violation and watch it
fail before trusting it. The agent skill at
`skills/drawio-diagrams/SKILL.md` in the tool repo documents behaviour, so
touch it only if an item genuinely changes what the skill describes. Do not
commit or push unless the session's user says to.

- [x] Dependency upgrade, `pngjs`: replace the hand-rolled PNG decoder in
      `src/png.js` (about 70 lines supporting only 8-bit RGB and RGBA,
      non-interlaced: a palette, 16-bit or interlaced PNG from any other
      exporter throws today) with the `pngjs` package. Preserve the
      exported contract exactly: `decodePng(buffer)` returns
      `{width, height, channels, at(x, y)}` where `at` yields `[r, g, b, a]`
      with `a=255` for RGB sources, so `src/measure.js`, the only consumer,
      needs no edit. The separate 20-line tEXt-chunk walk in
      `src/extract.js` (`mxfileFromPng`, which reads the model a
      `.drawio.png` embeds) stays hand-rolled: `pngjs` does not surface
      tEXt chunks cleanly and those bytes are the tool's core input path.
      Prove the swap with `measure` runs on a committed flow PNG before and
      after (identical output), then the full verification sweep.
      DONE. `pngjs@7.0.0` pinned exact, not deprecated, zero transitive
      deps. `src/png.js` went 68 lines to 21 wrapping `PNG.sync.read`, the
      exported contract intact (`channels` from `png.alpha`, `at` still
      yields `a=255` for RGB). `measure` before/after over all six
      committed pairs (598 output lines): byte-identical. The widened
      format support was executed, not inferred: a hand-built palette
      (colour type 3) PNG the old decoder rejected with "unsupported PNG
      colour type 3" decodes correctly now. Full sweep green (`npm test`,
      `test/lint-violations.mjs`, `lint --strict` at 0/0 on all six
      pairs). `mxfileFromPng` in `src/extract.js` untouched as specified.
- [x] Dependency upgrade, `commander` (or `yargs` if commander cannot
      express a behaviour below): replace the hand-rolled argument parsing
      in `src/cli.js` (the per-verb `runExtract`/`runRender`/`runCells`/
      `runMeasure`/`runSetGeometry`/`runSetWaypoints`/`runSetLabelOffset`/
      `runDiffCells` loops plus the `USAGE` string, which becomes generated
      help). Behaviours to preserve exactly, each worth a test: repeatable
      `--cell`/`--fit`/`--gaps` id options where an id may NEVER begin with
      a dash (a flag mistaken for an id must fail loudly), `--png`/`--svg`
      taking an OPTIONAL path value, `render --force` failing with its
      teaching message ("render always overwrites its derived outputs, no
      flag needed: drop --force"), scale and border defaulting from the
      nearest `drawio.config.json` with the `config: <path>` stderr note
      only when the config supplies a value, reports on stdout and
      diagnostics on stderr, and nonzero exit on any failure. History that
      motivates this: two real defects lived in the hand parser (a
      silently swallowed `--fit` given as `--cell <id> --fit`, and flags
      consumed as variadic ids), so encode those two exact invocation
      forms as must-fail tests.
      DONE. `commander@14.0.3` pinned exact, not deprecated: 15.0.0
      requires Node >= 22.12 against the repo's `engines.node >= 20`, so
      14.0.3 is the newest release the engine floor admits. No yargs
      fallback was needed. All eleven verbs ported, `render --force`
      declared hidden so its teaching message fires unadvertised, and a
      `DrawioCommand` subclass keeps the exact stderr strings and exit
      codes. New `test/args.mjs` (74 checks) wired into `npm test`, both
      historical defect invocations encoded as must-fail tests, and each
      guard proven by planting its removal and watching the suite fail. A
      60-invocation before/after battery differed only where intended:
      USAGE dumps became generated help, and `--help` now exits 0 with
      help on stdout. Full sweep green, all six pairs at 0/0. Two
      premises corrected in passing: the `config:` note actually prints
      when a config file exists and a flag was omitted (it never checks
      whether the file sets that key, and tests now pin all three cases),
      and `measure --scale abc` yields `scale=NaN` garbage where `render`
      rejects it (preserved verbatim, worth a separate item).
- [x] Dependency upgrade, `he` (HTML entity codec): the repo decodes XML
      entities in THREE separate hand-rolled implementations that have
      already drifted in coverage: `decodeEntities` in `src/extract.js`
      (named plus numeric), a five-entity `decodeEntities` in
      `src/render.js` (page-name matching in `selectPage`), and the
      fixpoint `decodeEntities` in `src/lint.js` (loops up to 8 passes
      since the webapp double-encodes values, with its own named-entity
      table). Replace the decoding core of all three with `he.decode`,
      keeping the domain logic that is NOT he's job: `src/extract.js`'s
      `decodeNumericEntities` deliberately keeps structural characters
      encoded (codes 34, 38, 60, 62) so round-trip greps stay well-formed,
      and lint's fixpoint loop wraps the decoder rather than being
      replaced by it. The three call sites keep their exact observable
      behaviour: the existing suites pin it.
      DONE. `he@1.2.0` pinned exact, not deprecated, zero transitive
      deps (CJS, so imported as default and called as `he.decode`). All
      three cores now call `he.decode` with `isAttributeValue: true`,
      since every site decodes an XML attribute value and that option
      stops he reading legacy semicolon-less references the hand tables
      never decoded. The domain logic stayed: extract's structural gate
      (codes 34, 38, 60, 62 remain encoded) and lint's 8-pass fixpoint.
      One genuine contract difference found and preserved: lint's hand
      table mapped `nbsp` to an ASCII space where he yields U+00A0, and
      label width estimates charge those differently, so the fixpoint
      body keeps an explicit NBSP-to-space `replaceAll`. Equivalence
      probe of old vs new decoders over the corpus: 81 files, 2879
      attribute values, 0 mismatches. `selectPage` proven on a synthetic
      multi-page file (apostrophe and hex refs now match, an
      improvement unreachable in the committed single-page corpus). Full
      sweep green, 65 before/after capture artefacts identical, all six
      pairs at 0/0. Noted for later: `label()` in `src/cells.js` holds a
      fourth, display-side entity handler, out of this item's scope.
- [x] Dependency upgrade, `fast-xml-parser`, scoped to the MODEL VIEW
      only: `parseCells` in `src/lint.js` parses the mxfile by splitting
      on `<mxCell` with regexes, which is fragile against comments, CDATA,
      exotic attribute quoting and nested same-name elements. Port
      `parseCells` (and only it) to a real parser, preserving its contract
      byte for byte: a Map keyed by cell id of
      `{id, attrs, style, geo, points, offset}` where `attrs` is the raw
      attribute map, `style` the parsed style-token map, `geo` the
      mxGeometry attribute map or null, `points` the `<Array as="points">`
      waypoints, `offset` the `as="offset"` mxPoint or null. Two encoded
      behaviours must survive: cells WITHOUT an id are skipped (an id-less
      cell once entered the map under the key undefined and made the
      parent walks cyclic, which is also why every `absOrigin` twin
      carries a cycle guard), and the malformed-model guard in `lint`
      compares the parsed cell count against the raw `<mxCell` occurrence
      count, which must stay meaningful. HARD CONSTRAINT: the byte-surgery
      path stays hand-rolled and gains NO parser: `cellSlice`/`cellXml` in
      `src/cells.js` and every editing verb in `src/edit.js` exist
      precisely to slice and splice the file's OWN bytes (attribute order,
      self-closing spellings and indentation preserved), and any
      parse-and-re-serialise there defeats the tool's design. Follow with
      the full verification sweep, and diff `cells --full` output on a
      committed flow diagram before and after: byte-identical.
      DONE. `fast-xml-parser@5.11.1` pinned exact, not deprecated.
      Parser configured for raw fidelity, each switch chosen against an
      observed default: `processEntities` off (consumers and `diffCells`
      compare raw strings, lint decodes to a fixpoint downstream),
      `parseAttributeValue` off (the default coerces `vertex="1"` to a
      number and `"0080"` to `80`), `trimValues` off (the default trims
      attribute values too), boolean attributes off, `preserveOrder` on
      (Map insertion order is load-bearing). Map-level old-vs-new
      comparison over all six pairs: identical in ids, order, keys,
      value types and values (100/99/203/142/150/165 cells). Both
      encoded behaviours planted and watched fail: with the id-skip
      guard removed the id-less cell entered under `undefined` and
      shifted a root cell's absolute origin, and the count guard fired
      on comment and CDATA plants (parsed 3 of 142) while not-well-formed
      input now throws one clean line and exit 1. `cells --full`
      byte-identical, `src/cells.js` and `src/edit.js` untouched, full
      sweep green, all six pairs at 0/0 with byte-identical notes. One
      premise corrected: `parseCells` always walked the whole document,
      not the first diagram, and its JSDoc now says what the code does.
      Flagged: 5.x carries six transitive deps where the `legacy` 4.5.7
      line carries one (`strnum`), a one-line downgrade if leanness
      outranks the 5.x line.

- [x] `extract` on a `.drawio.png` races through a shared temp path under
      concurrent renders: with several agents rendering at once it twice
      returned a SIBLING diagram's model for a different PNG (observed
      returning withdraw's then deposit's model when asked for swap's).
      The workaround that held: decode the PNG's own `mxfile` tEXt chunk
      directly. Fix: derive the temp path from the input file (hash or
      per-invocation tmpdir), and add a guard asserting the extracted
      `<diagram>` name matches the requested file.
      DONE, with the premise corrected: extract uses NO temp path at all
      (it reads the PNG's own tEXt chunk directly), and nine concurrent
      extracts across the three flow PNGs each returned their correct
      model. The observed cross-talk was the agents' SHARED SCRATCHPAD
      (sibling agents overwrote each other's scratch copies, which a
      second agent independently reported the same day). The guard half
      landed: extract prints the extracted diagram name(s) on stderr and
      notes a single-page name that differs from the file's basename, so
      a wrong input is visible immediately.

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
- [x] Editing verbs that write the raw file in place preserving its
      serialisation: `set-geometry <id> --x/--y/--width/--height`,
      `set-waypoints <id> "x1,y1 x2,y2 ..."`, `set-label-offset <id> <dx>
      <dy>`. Every geometry change today is hand-computed model arithmetic
      (lane interiors, box centres, polyline lengths for label `pos`) turned
      into regex surgery, which carries both arithmetic and serialisation
      risk.
      DONE: all three verbs land, built on the byte-exact cell locator
      `cells --xml` uses, splicing the smallest span inside the element
      and leaving the rest of the file byte-identical (proven by a
      set-then-restore round trip whose only surviving diff was the
      canonical spelling of the new content itself). Each edit verifies
      the parsed result before writing (write-then-rename), and refuses
      rendered inputs, duplicate ids and unknown ids loudly. Geometry
      values are parent-relative, which the skill now states.
- [x] `measure` on an edge label: report the label's own text-ink bbox
      separately from foreign ink inside the estimated box, and tighten the
      char-width estimate toward measured Helvetica ink (about 6 u/char
      against the roughly 7.08 used). `g3-l` reported all-zero padding,
      which reads as "a line touches this text on all four sides", when the
      cause was the over-wide estimated box clipping an unrelated edge that
      the crop shows 27 units clear of the text.
      DONE: the estimate is now a probe-calibrated char-class model
      (uppercase and digits 7.9u, spaces 3.4, thin glyphs 3.8, other
      lowercase 6.2, Menlo 7.1 flat, bold lines +5%), within about 4% on
      the probe strings. An edge label measures its TEXT box (align and
      verticalAlign aware) and scans a 4-unit halo separately, naming
      foreign ink (the edge's own stroke included) instead of reporting
      it as zero padding. Verified live on deposit's e2b-l.
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
- [x] `measure --gaps <container>`: report each child's clearance to the
      container's four sides and the largest empty rectangle inside it. The
      underhang item, a pure dead-space question, was answered by
      transcribing lane geometry out of `cells` and subtracting by hand.
      DONE: per-child four-side clearances plus the largest empty
      rectangle (candidate edges from the child boxes), verified against
      the deposit vault lane's twelve children.
- [x] Lint: flag an edge-label box overhanging the model bounds by more than
      the render border. Labels never extend the export bounds, so a slid
      label clips silently: `e4b-l`'s clearance inside the right bound was
      hand-checked against the border arithmetic.
      RESOLVED as a corrected premise, no check: the exporter DOES extend
      its bounds to include edge labels. Proof by residual arithmetic:
      folding deposit's estimated label boxes into the predicted bounds
      lands within 3,6px of the actual PNG, while ignoring them would
      predict roughly 21px the other way, and the generic pair's
      furthest-slid label renders with the full border intact beside it.
      A slid label does not clip, so the warning would flag a non-defect.
      measure's calibration line names label extensions instead.
- [x] `measure` (or `render`) prints the model-to-pixel affine on request
      (scale and offset per axis), so a `sips -c` crop of a model region is
      one computation instead of three. Every crop in the actor-map upgrade
      needed the calibration line transcribed and applied by hand.
      DONE as `measure --affine` (valid with no `--cell`): four
      substituted formulas, px from mx and back per axis, printed from
      the same calibration the verb measures with. Hand-applying them to
      `n-read`'s box reproduced measure's own ink numbers exactly.
- [x] Lint: check leads as well as tails (the tail check catches a first
      segment under 40 units out of the source, but nothing checks the
      final segment into the arrowhead), and flag a shape-to-edge clearance
      under 20 units for edges passing close to unrelated shapes. Both were
      eyeball-only on the deposit inherit rebuild, and the tail check's
      three genuine catches there show the lead-side twin would pay for
      itself.
      DONE: the lead check already existed at error tier (verified in
      source and behaviour), and the clearance half landed as a note:
      a run passing alongside an unrelated shape under 20 units, with
      same-stroke-colour furniture exempt (a step circle deliberately
      hugs its own step's edge). On the committed pairs it fires one to
      four genuine crowding notes per flow diagram.
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
- [x] Lint: label-over-label overlap promotes from advisory to error once
      label boxes come from measured ink instead of char estimates (the
      measured-ink rework is the `measure` edge-label item above).
      DONE with the estimate kept honest: an overlap surviving both boxes
      shrunk 20% per side is beyond the calibrated estimate's error and
      is an ERROR, a marginal graze stays a note pointing at the render.
- [ ] Lint (advisory, later): initiator direction: the bold prefix should
      name the edge's source-side lane or actor, via a small per-diagram
      alias table.
- [x] Golden-rules checks promoted from note to error tier. The
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
      DONE: all three checks are error tier, made trustworthy first by
      fixing the align=left half-width defect and calibrating the width
      estimate (the sources of every prior false strike). Re-run over all
      six committed pairs: zero errors, zero warnings, nothing to fix.
      The tool repo's planted-violation suite proves each check fires and
      each clean control passes.
- [x] Lint or membership tooling: flag a re-anchored background edge by
      name. `exitX`/`entryY` live in style, so re-routing an inherited edge
      silently breaks the flow-membership byte-identity, and only the
      membership script's generic "style differs" catches it. A check that
      says "background edge re-anchored: <id>" turns a puzzling diff into a
      named defect.
      DONE as the new `diff-cells <a> <b>` verb: cell-level id, value and
      style comparison (geometry excluded on purpose), where a style
      delta confined to exit and entry anchor tokens reports as "edge
      re-anchored" with the exact token pairs named. Proven on a planted
      anchor change, and the membership scripts can now build on it.
- [x] Lint: narrow the stacked/parallel-run checks to runs whose x (or y)
      spans actually overlap. Runs 60 units apart horizontally are
      currently reported as stacked, and every such note costs a
      read-and-justify round. Nuance from the generic-pair
      normalisation: 3 of its 4 baseline stacked notes named disjoint
      runs and aligning them was still the right fix each time, so the
      narrowing should demote such hits, not silence them.
      DONE as demote-by-naming: a disjoint-span stacked note now carries
      "(disjoint spans, Nu void between them)" so the reader has the
      weaker-signal context inline, and nothing is silenced (the
      overlapping-span case was already the separate NEAR error).
- [x] Lint: flag text ink wider than its box (a long unbreakable token like
      `completeWithdraw(...)` overflows its caption and paints over
      neighbours, invisible in XML and to every current check): pairs with
      the open `measure --fit` item.
      DONE as a note from the calibrated estimate: the longest
      unbreakable token per line against the declared width (wrapping
      cannot save a token), with icon cells exempt since their captions
      render outside the box by design (`verticalLabelPosition`).
- [x] Render and lint: fail loudly when the parsed cell count is far below
      the source's `<mxCell` count. A malformed geometry splice (broken
      `<Array as="points">` handling) rendered "loaded 2 of 145 cells" as
      an easily missed log line while producing a blank-looking PNG.
      DONE: render's guard already existed (verified failing loudly on
      the id="map" landmine), and lint gained its twin: parsed cells
      under half the raw `<mxCell` count is an error naming the malformed
      model. Building its planted violation also surfaced and fixed a
      latent hang: an id-less cell entered the cell map under the key
      undefined and made the parent walk cyclic (parser now skips id-less
      cells and every parent walk carries a cycle guard).
- [x] Palette: add a ledger record-block sample and a step-caption sample
      carrying a realistically long circuit token: both shapes exist in
      committed diagrams but have no copy source on the card, so agents
      reverse-engineer them from diagrams instead of copying.
      RESOLVED without an edit: the committed palette already carries the
      record-block copy source (`ledger-node`, value `ledger
      ExampleLedgerMap { RequestId-style record }`, rendered on the
      card), and the step-caption half is obsolete: step captions were
      abolished by the every-arrow-describes-itself rule.
- [x] Skill: concurrent-editor guard: hash the target `.drawio` before and
      after every edit batch and re-check before finishing. Mid-task an open
      draw.io editor re-serialised `deposit.drawio` under the executing
      agent (cell order rewritten to webapp order, `d2`'s waypoints
      collapsed 4 to 2), detected only via `git diff --stat`, and an editor
      holding a stale buffer can save over finished work after the fact.
      DONE: the skill's editing section now mandates the hash-before,
      hash-after, re-check-before-finishing discipline.
- [x] Lint: error on any `image=` style referencing a remote host
      (`http://`/`https://`). A palette cell shipped
      `image=https://images.icon-icons.com/...`, which renders BLANK in the
      offline renderer and violates the icons rule, and nothing caught it:
      the failure is invisible in the XML and only an eyeball of the render
      shows the empty box.
      DONE: error tier, planted and proven, embedded data: URIs pass.
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
- [x] `measure --fit` on a stroked shape counts the border as ink:
      `--fit hex-resp` on the generic pair advises growing a hexagon
      that already hugs its label. Restrict the fit verdict to text
      ink, or subtract a detected border rectangle before applying the
      8/6 padding.
      DONE by peeling: the fit grows its scan inset until the measured
      ink pulls clear of the scan window on every side (border strokes
      touch the window, text does not), capped at 12 units and named in
      the verdict when a peel was needed.
- [x] measure and lint centre an `align=left` edge label's estimated
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
- [x] `measure --affine` (and the calibration under it) reports a bogus
      affine with a huge residual shift when the PNG was rendered at a
      scale other than the config's (a scale-1 render produced a
      nonsensical -1182,-837px shift with no hint of the cause): detect
      the scale mismatch and warn loudly instead of publishing numbers.
      DONE as a hard failure naming the implied scale, and it promptly
      caught the tool repo's own smoke test measuring a scale-3 render
      against a planted scale-1 config.
- [x] Lint editor-junk check learns `<font color="...">` as a junk
      token: the generic pair's `n-sign` and `n-attest` carried
      `<font color="#000000"><br></font>` (editor residue wrapping an
      invisible line break), which the inline-CSS token matching does
      not see.
      DONE, warning tier with a planted violation proven.
- [x] `measure` flag parsing after `--cell <id>`: `--fit` given in the
      form `--cell <id> --fit` is silently swallowed as a valueless
      flag (no fit line, no error: the working form is `--fit <id>`),
      and `--quiet-calibration` after `--cell <id>` is consumed by the
      variadic id list ("cell --quiet-calibration: not a vertex") while
      the chatter prints anyway. Parse flags before variadic ids, or
      fail loudly.
      DONE, largely by an earlier parser rework (both reported forms now
      behave, reproduced before touching anything), plus the remaining
      hole closed: an id argument beginning with a dash fails loudly
      instead of being measured as a garbage id.
- [x] `measure --fit` double-counts a text cell's own spacing tokens:
      `n-read` carries `spacingLeft=8;spacingRight=8`, its measured ink
      already sits inside that inset, and the fit adds the 8u rule on
      top ("delta +12x+2" on a correctly hugged box). Subtract declared
      spacing from the implied box, or name the spacing in the verdict.
      DONE by naming: the verdict appends the declared spacing tokens so
      the reader sees what part of the delta they restate (subtracting
      them would guess at the interplay with the padding rule).
- [x] Calibration demotion covers only edge-LABEL overhangs, so a
      bound-setting EDGE keeps the warning loud forever: the actor map
      now warns on `bottom=dvaddr-acct` with a fully explained 30px
      residual (the webapp pads an edge's bounds beyond its declared
      polyline). Extend the demotion to an attributed bound-setting
      edge whose residual sits within the border.
      DONE: label boxes now fold into the calibration's content bounds
      (so label overhangs stop producing residuals at all), and a
      residual whose bound-setters on the offending axes are edges
      demotes to a note inside the border. Smoke-proven with a
      deterministic edge-bound fixture.
- [x] Guide-vs-tool gap on same-colour crossings, a DECISION before any
      code: lint holds every crossing of two default-stroked edges as
      an ERROR (which forces the derivation layer planar and drove the
      actor map's bus design), while docs/diagramming.md scopes the
      no-crossing rule to step colours and elsewhere invites
      `jumpStyle=arc`. Either the guide states plainly that neutral
      edges may not cross either and jumps are for step layers only, or
      the check exempts crossings carrying an explicit jump. A design
      round was burned on the gap.
      DECIDED for the tool's behaviour, which the actor map's bus was
      already built on: the guide now states that two edges of the same
      stroke colour never cross, default black included (the derivation
      layer stays planar), and jumps exist for cross-colour crossings
      only.
- [x] Skill: note in the verify section that the model-to-pixel affine
      changes whenever an edit moves the model bounds, so
      `measure --affine` is re-read after every render, never cached
      across edits (the actor-map bus grew the bottom bound and shifted
      the y offset mid-task).
      DONE in the skill's measure section.
- [x] Lint: visible-run check (the knockout-gap check, re-aimed by the
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
      DONE in measure, the pixel verb, at the prescribed +-40/channel
      tolerance: every measured edge label appends a "visible run" line
      with the units surviving each side of its knockout, under 20u
      named as an orphaned stub. Furniture crowding stays with lint's
      new clearance note, which covers it statically. Verified live on
      deposit's e2b-l and on a deliberately stubbed fixture.
- [x] `measure --affine` bakes the calibration residual into its
      offset: it printed `px = (mx-347)*3 + 54` for a render whose true
      mapping is `+76` (a 22px error, enough to miss a 6px stroke),
      because the residual shift it derives includes the attributed
      label-overhang error its own calibration line warns about.
      Subtract the attributed overhang before deriving the offset, or
      refuse to print an affine while a live calibration WARNING
      stands. Distinct from the scale-mismatch item above: this fires
      at the correct scale.
      DONE, both halves: the calibration folds label boxes into its
      content bounds so the attributed overhang stops polluting the
      offset (deposit's residual fell to 3,6px), and the affine REFUSES
      to print while a live WARNING stands.
- [x] Lint: the floating-connection warning fires on palette sample edges
      whose endpoints are zero-area point shapes, where exit and entry
      sides are geometrically meaningless. The samples were pinned to
      silence it, which adds noise to satisfy a check: either exempt edges
      between zero-area shapes or accept pins as the convention and say so
      in the skill.
      DONE as the exemption: an unpinned edge between two degenerate
      specimen points skips the warning (the specimen predicate the
      label exemptions already use), a real unpinned edge still warns,
      both proven by fixtures.

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
5. Grep the correspondence: each canonical string exactly twice on its flow
   page (one step-list bullet, one mermaid note), and NONE of it in the flow
   diagram. The bullet occurrence matches `^- \*\*N\.\*\* <tail>` (the
   string's tail after `Step N: `, never a fragment: circuit tokens like
   `deposit(...)` recur legitimately in prose and code), the note occurrence
   carries the FULL string on a `Note over` line inside the mermaid fence.
   Diagram side: no cell text contains `Step N:`, and the numbered circles
   carry exactly the frozen strings' ordinal multiset (one circle per branch
   arm).
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
  a label riding a step edge, dying with its edge. The background contains NO phase-stroked cells: the
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
