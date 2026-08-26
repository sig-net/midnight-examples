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
- [ ] Replaces the integration repo's copy (C5 below).

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
- [ ] Deposit `d2` re-synced: the ledger-anatomy item re-routed the actor
      map's `d2` (anchor moved onto `acct-vault`'s top) AFTER the deposit
      inherit item built from the map at the previous HEAD, so the deposit
      copy of `d2` differs in style by exactly that pin. Once the completed
      map lands, update deposit's `d2` to the map's style byte-identically
      and re-route its polyline legally, then lint, membership proof (must
      return to zero mismatches), re-render, eyeball.

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
- [ ] Palette follow-up: the EXAMPLE_SECRET icon cell still carries the
      bare webapp id `2` (kept during the icon swap to preserve the
      authored cell). Rename it to a descriptive id
      (`secret-node-icon`) in a quiet change: the palette is a copy
      source, so copies made before the rename are unaffected.
- [ ] Iconography formalised: palette and rules only, no flow or actor
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
- [ ] Witness icon swept through the diagrams, AFTER the iconography item
      above lands and the in-flight withdraw diagram work is done: every
      witness member row switches from the cog to the open-eye icon copied
      from the palette's iconography entry, in the actor map, deposit and
      withdraw pairs in ONE change (the icons rule's same-change sweep).
      Lint --strict every touched pair, re-render all of them, eyeball
      crops of every witness row at display size, and re-run each flow
      diagram's membership proof (the witness row's style changes in the
      actor map and every flow copy together, staying byte-identical).
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
- [ ] Actor map ledger anatomy completed: the contract exports 17 ledger
      fields while the map carries 3 (`signBidirectionalEventMap`,
      `mpcResponseKey`, `vaultEvmAddress`), so the missing 14 join the
      ledger section, in two columns as the circuits section already does,
      record types as record blocks and scalars as single lines, styled
      from the existing ledger rows, and the map pair re-rendered (the
      vault README's embed path is unchanged). Decision recorded: the
      anatomy completes literally, the rule stands as written ("every
      ledger field"), no grouping.
- [ ] `docs/withdraw/withdraw.drawio(.png)`: canonical step strings frozen
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
      (separate PR, referenced from this repo's PR).

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
- [ ] `cells --xml <id>` (or `extract --raw-slice <id>`): print the exact
      source bytes of one cell's element from the raw file. `cells` and
      `extract` both re-serialise (`/>` spacing, geometry elements
      self-closed differently from the file), so substrings copied from
      their reports fail to match the file in string surgery: the underhang
      edit script failed 12 of 13 patches this way on its first run.
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
- [ ] `measure` calibration warning: suppress it below a threshold or behind
      a `--quiet-calibration` flag once the residual is fully attributed. On
      the deposit diagram it fires twice per invocation, always naming the
      same four bound-setting cells for an explained, harmless 27px
      residual.
- [ ] `measure --gaps <container>`: report each child's clearance to the
      container's four sides and the largest empty rectangle inside it. The
      underhang item, a pure dead-space question, was answered by
      transcribing lane geometry out of `cells` and subtracting by hand.
- [ ] Lint: flag an edge-label box overhanging the model bounds by more than
      the render border. Labels never extend the export bounds, so a slid
      label clips silently: `e4b-l`'s clearance inside the right bound was
      hand-checked against the border arithmetic.
- [ ] `measure` (or `render`) prints the model-to-pixel affine on request
      (scale and offset per axis), so a `sips -c` crop of a model region is
      one computation instead of three. Every crop in the actor-map upgrade
      needed the calibration line transcribed and applied by hand.
- [ ] Lint: check leads as well as tails (the tail check catches a first
      segment under 40 units out of the source, but nothing checks the
      final segment into the arrowhead), and flag a shape-to-edge clearance
      under 20 units for edges passing close to unrelated shapes. Both were
      eyeball-only on the deposit inherit rebuild, and the tail check's
      three genuine catches there show the lead-side twin would pay for
      itself.
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
- [ ] `measure --fit <cell>`: print the box implied by the uniform-padding
      rule (8 side, 6 vertical) for the cell's measured text ink, so sizing
      a box takes one pass. Character-width estimates are off by about 10%
      (8.1 predicted against roughly 7.4 actual for bold Helvetica caps),
      which cost a render-measure-adjust loop per box across five boxes in
      the keyDerivation alignment.
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
