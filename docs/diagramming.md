# Diagram style guide

Every draw.io diagram in this repository follows the
[drawio-cli style guide](https://github.com/BRBussy/draw-io-cli/blob/main/docs/style-guide.md):
the committed pair, the edge-label golden rules, the routing rules, the layered
composition, the working-size budget, the curated-layout mandate and the project
layout all bind here exactly as that page states them, and this page never restates
them. This page holds only what is specific to these diagrams: what the colours mean,
the verb table, the shapes that carry this protocol's concepts, which cells a flow
diagram keeps, and the icon bank. The palette card at
[diagram-palette.drawio.png](diagram-palette.drawio.png) shows each convention rendered,
and its source [diagram-palette.drawio](diagram-palette.drawio) is the copy source: take
styled cells from it rather than restyling by hand. Render settings and the lint
vocabulary live in [drawio.config.json](../drawio.config.json) at the repository root.

**TIP:** If you are using a coding agent you can ask it to edit and render diagrams for
you: it can extract, edit, render, lint and visually verify the result on your behalf.

## Colour palette

Colours mean protocol phases. Everything that belongs to one step, the numbered
circle and every arrow of that step, uses its phase's colour, and nothing else does.
Step numbers are ordinals per diagram, 1..N in that flow's execution order, so a phase
keeps its colour in every diagram whatever number it carries there. The fund phase is
the user's own wallet moving value on the foreign chain before any contract is involved,
and it appears only in flows that begin with such a transfer.

| Phase | Colour |
|-------|--------|
| fund | `#008695` |
| request | `#E73F74` |
| signature | `#3969AC` |
| broadcast | `#11A579` |
| attestation | `#FDAE61` |
| settle | `#7F3C8D` |

Everything else stays neutral: default black strokes on a white background, swimlanes
and shapes unfilled. Coloured step edges turn their corners as arcs, and the broad-dashed
derivation edges keep sharp corners, both carried by the palette's swatches.

## Labels

- Prose labels use the default font (Helvetica).
- Circuit labels render as code: Menlo/Monaco monospace at 12px, the keyword (`circuit`)
  in `#AF00DB`, the identifier in `#202020`. Copy the sample cell from the palette card.
- **Truth priority: code > README > diagram.** When a term exists in more than one
  place, a label takes it from the leftmost source that has it: circuit, event and
  ledger-field spellings come from the contract source, step phrasing comes from the
  README, and a diagram invents wording only where neither has any.
- **Every bit of text directly associated with an edge IS an edge label.** Whether it
  rides the edge or would sit beside it, arrow-associated text is authored as a label
  riding that edge and follows the edge-label golden rules below, the strict format
  included. Free-standing text shapes beside an arrow are forbidden: a diagram
  identifies its steps by the phase colours and the numbered circles alone, and the
  canonical step strings render only on the flow page (its step-list bullets).
  The diagram-to-page link is the ordinal set: the circles' numbers
  are exactly the frozen strings' ordinals, a branch's arms sharing one ordinal and
  one circle. Every step arrow DESCRIBES itself: each logical arrow of a
  step carries an acting-party label saying what happens along it (a run drawn as
  one edge carries one label, and a bundle segment that merely continues an
  already-labelled arrow of the same step adds nothing). A code label (whole text a
  call expression) satisfies this on its own where the call IS the action. An
  unlabelled step arrow is a defect: the reader must never have to infer an arrow's
  action from its endpoints alone.

### Edge-label golden rules (NEVER BREAK)

Edge labels are the diagrams' descriptions, and these rules hold ALWAYS: follow them no
matter what, growing the diagram until they fit (the golden precedence in the
working-size section).

- **The run passes through the label's centre**: a horizontal run through the label's
  vertical midpoint, a vertical run through its horizontal midpoint, the background
  knockout breaking the line behind the text. The ONE exception: when the run is too
  short for the label to cross it, the label sits alongside as close as possible, and
  the run then passes on the label's LEFT (vertical run) or its top or bottom
  (horizontal run), never its right.
- **The knockout hugs the text, and the run survives it**: the break a label makes in
  its run covers the text ink plus a small margin and never the label box's empty
  padding, and visible line remains on BOTH sides of the break. An arrowhead sitting
  straight on the text, or a stub too short to read as a line, means the run is too
  short for the label it carries: grow the gap between the shapes the run joins until
  the line reads (the golden precedence), and never shrink the label or slide it off
  its run instead. Keep the run's own furniture clear of the break too, since a step
  circle beside the last few units of a stub leaves no clean line to read. A label on
  a vertical run is free to slide ALONG it to find that clean space, its horizontal
  centring being the part the seating rule fixes.
- **Alignment follows the crossing axis**: `align=left` when the run crosses the label
  horizontally, `align=center` when the run is vertical, the alongside case included.
- **The edge starts at the initiator**: the source is the party performing the action,
  the arrowhead lands on the acted-upon. A read points AT the thing read.
- **Strict label format**: the first line is the acting party, bold and
  colon-terminated (`MPC:`, `dApp/relayer:`, `startCrossChain circuit:`: an actor, a
  lane, or a circuit), and the body starts with a capitalised verb from the verb table.
  Verbs stay normal weight: bold remains reserved for the acting-party prefix and the
  greppable names. The label cell's copy source is the palette card's Edge labels
  section, which seats the format on a horizontal run and on a vertical one.
- **Label texts never overlap one another.**

Two narrow exemptions, and only these: a label whose WHOLE text is a call
expression (`transfer(vaultEvmAddress, amount)`) is a code label, exempt from
the format rule. A label on a specimen edge (both endpoints degenerate points
of 4 units or smaller, the palette card's swatch construction) is a legend
caption naming the style it demonstrates, exempt from the format and
alignment rules: the seating rule still applies to it, a legend caption
riding its swatch crookedly is a defect on a copy-source card.

### The verb table

One verb, one meaning, everywhere an edge label or note describes an action:

| Verb | Who says it | Means exactly |
|------|-------------|---------------|
| Interacts with | User | drives a dApp's UI, no chain involved yet |
| Funds | User's own wallet | moves value on the foreign chain before any contract is involved (the fund phase) |
| Starts | dApp/relayer, User | kicks the flow off by calling the entry circuit |
| Calls | a circuit | one circuit invoking another |
| Constructs | a circuit | builds and stores a request on the ledger |
| Reads | MPC | pulls stored state off the ledger |
| Picks up | MPC, dApp/relayer | notices an on-chain occurrence it polls or watches for |
| Posts | MPC | writes a response event back on-chain |
| Signs | MPC | produces the signature (note scaffold) |
| Attests | MPC | produces the execution attestation (note scaffold) |
| Extracts | dApp/relayer | pulls a field out of an event or receipt it already has |
| Broadcasts | dApp/relayer | sends a signed transaction to a chain |
| Submits | dApp/relayer, User | hands data into a circuit call to settle or complete |

Sending a signed transaction to a CHAIN is always Broadcasts, and handing data into a
CIRCUIT call is always Submits. When no row fits an action, the table extends: a new
verb lands as one row here and in the config's `lint.verbs` (verb, who says it, exact
meaning), in the same change as its first label, keeping one verb one meaning.

## Shapes

- Swimlane per chain or system, nested swimlanes for contracts, each lane's header
  unit carrying the icon the [iconography table](#iconography) gives it. The single
  exception to the centred header unit: a contract lane whose address participates in
  key derivation carries its broad-dashed identity node horizontally centred directly
  below the header unit. A lane whose logo includes its wordmark (Midnight) uses the
  logo alone as the unit.
- The MPC lane draws its servers as the palette's server-cluster group, three server
  towers around the Sig Network roundel. The cluster sits horizontally CENTRED in the
  lane when nothing shares its vertical band. When other content overlaps that band on
  one side within the minimum padding, the cluster moves to the top corner AWAY from it
  (content on the left pushes it top-right, content on the right pushes it top-left).
- The User actor is the composite group from the palette card: bold caption above, the
  blue person shape behind, the wallet icon in front. The User's wallets sit with it
  inside one actor-cluster rectangle.
- The contract/dApp icon runs about 5 units light on the right, so its cell sits 1 unit
  right of centre when centred on its rendered ink.
- Contract members are the ledger state, witnesses and circuits, each a member node
  whose icon the [iconography table](#iconography) gives that kind and whose code text
  opens with the compact keyword (`ledger`, `circuit`, `pure circuit`, `witness`). They
  stack in sections in this fixed order: ledger, witness, circuits, pure circuits
  (present only case by case).
- An identity secret renders as the palette's secret-node sample: a dotted-border box,
  the secret icon, and the value's name in Menlo bold.
- Key derivation renders as a keyDerivation note plus broad-dashed edges. The note
  carries the abstract call `keyDerivation(<version>, <inputs...>, <path>)`, one
  argument per line. `keyDerivation` greps nowhere by design (it stands in for the
  SDK's derivation functions, which the docs name). Every argument token that greps in
  source (env-var names, circuit names, path literals) is bold, the rest is not.
- Behaviour notes on the MPC lane share the colon-led scaffold (`Signs: <object> With:
  <instrument>`, `Reads: <object> On: <trigger>`, `Attests: <object> With:
  <instrument>`), the greppable instrument bold.

## Flow diagram membership

An example's actor map carries the contract's full anatomy (every exported circuit,
every witness and every exported ledger field, exported pure circuits omitted by
default) and the full cast of actors, and each flow diagram keeps only what that flow
interacts with. Membership, for members and actors alike, is read from the contract
source and the flow's executable flow files (`integration-tests/src/flows/`), never
from prose.

Kept cells stay byte-identical to the actor map's, with ONE value exemption: the MPC
lane's `n-read` note names in its `From:` section the request event map(s) actually
present in that diagram's contract box, each name bold. With one map the name shares
the `From:` line (`From: bidirectionalDepositMap`), and with more than one the `From:`
keyword takes its own line and each name follows on its own line. The actor map lists
every request event map, and a flow's copy lists exactly the ones its box carries, so
the note always names the true ledger state the MPC reads. The cell-level check runs
`drawio-cli diff-cells` between the flow and the actor map, the `n-read` `From:` line
checked against the diagram's own map rows instead.

1. **Layer 1: shapes and their labels.** Boxes, hexagons, icons, notes. Composed FIRST,
   as a deliberate arrangement: siblings align on shared coordinates (the circuits inside
   a contract stack at one x with even vertical spacing), gaps are consistent, icon
   captions sit above their icons. The test: delete every line from the diagram and what
   remains still looks intentionally placed. A layer-1 item never sits somewhere that only
   makes sense once the lines are drawn (an indented circuit "making room" for an edge is
   a defect: the edge routes around, the circuit stays in its column).
2. **Layer 2: lines and step circles.** Routed around layer 1 per the edge rules below.
   A numbered circle sits at touching distance from its step's MOST SALIENT edge, the
   one a reader would name as "the step happening" (for the request step that is the dApp calling
   the circuit, not the user tapping the dApp). The salient edge is the acting actor's
   own call edge, never a downstream edge of the same colour. When no edge is obviously
   more salient than its siblings, use the step's first edge at its source shape. Never floating in
   whitespace, never equidistant between two steps.
3. **Layer 3: line text.** Edge labels annotate layer 2 without colliding with either layer.

## Flow diagram membership (NEVER BREAK)

An example's actor map is the ONLY diagram showing the contract's full anatomy
(every exported circuit, every witness and every exported ledger field) and the full
cast of actors. Exported PURE
circuits stay off the diagrams by default (they are helpers, not protocol
surface): a specific document may reintroduce one deliberately, case by case.
A flow diagram's contract box
carries ONLY the members (ledger fields, circuits, witnesses)
that flow interacts with, so a new member dirties one diagram, not one per
flow. The same bar holds for actors, in EVERY lane: a flow diagram draws ONLY
the actors that flow interacts with. A foreign-chain actor the flow never
touches, a User-cluster member with no edge in the flow, and a derivation
note whose only consumer is a deleted actor all go, and the full cast
appears on the actor map alone. Actor-level behaviour notes and their edges
live on the actor map alone: a flow diagram's step layer tells the same
story per flow with its labelled step edges. Membership, for members and actors alike, is
read from
the contract source and the flow's executable flow files
(`integration-tests/src/flows/`), never from prose.

A flow diagram starts as a copy of the actor map with its `<diagram>` tag
renamed, the non-interacted contract members and actors deleted, and the
flow's step layer
appended. Deletion works the same at both scales: a member row or an actor
(with its edges, and any note that serves only it) simply goes. Every kept
cell, contract members, actors and the rest of the background
alike, keeps its id, value and style byte-identical to the actor map's cell of
the same id: copy, never re-author. Only geometry may adapt, as the contract
box tightens around the surviving members and the lanes close over the
deleted actors. ONE value exemption exists: the MPC
lane's `n-read` note names in its `From:` section the request event map(s)
actually present in that diagram's contract box, each name bold. With one map
the name shares the `From:` line (`From: bidirectionalDepositMap`), and
with more than one the `From:` keyword takes its own line and each name
follows on its own line.
The actor map lists every request event map, and a flow's copy lists exactly
the ones its box carries, so the note always names the true ledger state the
MPC reads. The rest of that note, and every other kept cell, stays
byte-identical. The check is cell-level, never a whole-file diff: strip the
step layer, then each remaining cell's id, value and style must match the
actor map's, the `n-read` `From:` line checked against the diagram's own map
rows instead.

**Trimming reclaims the space it frees.** Deleting members shrinks the
containers, deleting actors shrinks the lanes that held them, and every lane
beside or below a shrunk container or lane moves in to
restore the normal inter-lane gaps, re-placing the step circles, edge labels and
edge runs that lived in the affected band. Tightening one box while the page
keeps its old extents is half the job: the freed area must leave the diagram,
pulling it back toward the working-size budget. The eyeball test: a reader
who has never seen the untrimmed diagram must not be able to point at where
the deleted cells used to be. A band of empty space whose only explanation is
"something was deleted here" is a defect, exactly as a broken label is.

## Captions and anchors

- **An icon's caption sits above the icon, centred** (text before image), everywhere:
  actors, servers, chains, the lot.
- **Edges anchor at the centre of the side they meet** (`0.5` on that axis). Never anchor
  at or near a corner of a text or image bounding box. On a shape taller than one line of
  text an off-centre anchor is allowed, but it keeps clear padding from the shape's edge,
  never hugging it.
- **An edge label sits per the edge-label golden rules** in the Labels section:
  centred on its run, or legally alongside when the run is too short to cross it.
  Offsets exist only to reach that seat.
- **Boxes hug their content with ONE uniform padding.** A node box's border keeps
  exactly 8 units of padding at the sides and 6 above and below the text (a
  single-line code cell is 28 units tall), so an anchor on the box edge is an anchor
  on the content. Roomier reads as emptiness, tighter reads as clipping, and every
  sibling box in a column carries the identical padding so the column reads as one
  family. An arrowhead that visibly stops short of the text means the box is too
  big, not the arrow too short.
- **Text sits visibly centred in its box**: node cells carry `verticalAlign=middle`
  with the uniform padding, so a `0.5` side anchor meets the text centre and the
  border frames the text evenly. Verify the centring in the render, never only in
  the XML. Copy the cell from the palette card, which carries these values.

## Edge routing (NEVER BREAK)

- **NO diagonal segments, ever.** Every edge is built from strictly horizontal and
  strictly vertical runs joined by clean corners.
- **Corners: step edges curve, everything else stays sharp.** Every coloured step
  edge turns its corners as arcs (`rounded=1;arcSize=20`, carried by the palette's
  phase swatches: copy the style, never re-author the tokens), so the step lines pop
  from the rectangular structure and the eye follows them immediately. Derivation
  edges (the broad-dashed black lines) keep sharp right-angle corners (`rounded=0`),
  as do lane borders and every shape. The runs themselves stay strictly horizontal
  and vertical in both cases: only the corner turns.
- **No almost-straight segments, ever.** A run is either perfectly straight or a
  deliberate 90 degree jog. An edge that is off-vertical or off-horizontal by a few
  pixels is a defect, not a route.
- **Edges are thicker than lane borders**: every connecting line carries `strokeWidth=2`
  (swimlane borders stay at the default 1), dashed derivation edges included.
- **Route around shapes.** An edge crosses another EDGE when it must (prefer a visible
  jump where the crossing is busy), but it never cuts through a shape while a route
  around exists. Event hexagons set their label as `Event` on the first row and the
  event name below it, which keeps them compact enough to route around.
- **Paired right angles align.** When two edges take the same style of corner near each
  other (along, then up, then along), their vertical runs line up on one x coordinate,
  as mirror images or both the same way. Two nearly-aligned verticals are a defect.
- **Step lines travel together.** All edges of one step (one colour) that leave the same
  shape anchor at one shared base, or immediately adjacent points on one side, and
  separate with one or two explicit 90 degree jogs. Never scatter a step's edges across
  different sides or distant anchors of a shape when a shared base is possible: prefer
  crossing another step's line over splitting your own step's lines apart.
- **A step never crosses itself, and neither does the neutral layer.** Two edges of
  the same stroke colour must not cross each other, the default black derivation
  edges included: same colour reads as one system, and a crossing inside one system
  reads as a junction. The derivation layer therefore stays planar, consolidating on
  shared trunks and buses where fan-in would force a crossing. When two edges share
  a source shape, order their anchors to match their targets so they fan out without
  crossing. A T-junction off a shared trunk is the sanctioned form of fan-out. Where
  DIFFERENT colours must cross, put `jumpStyle=arc` on the crossing edge so the
  crossing reads as a jump, never as a junction: jumps exist for cross-colour
  crossings only, never to excuse a same-colour one.
- **Tails and leads run at least 40 units.** On any edge with a corner, the first segment
  out of the source and the final segment into the arrowhead each run at least 40 units
  before bending. A bend hard against a shape reads cramped.
- **Arrowheads land in clear space.** No other line passes within 20 units of an
  arrowhead's landing point (the arrow glyph itself occupies real space), and no line of
  the SAME colour passes within 40: an unrelated same-colour line near an arrowhead
  reads as a junction. An arrowhead never sits on another edge: lengthen or reroute to
  make room. Several arrowheads deliberately sharing one anchor point are the allowed
  exception.
- **Prefer: corners need a cause.** Every corner should be justified by an obstacle or
  another rule. If sliding an anchor within its side's allowed band removes a corner
  without breaking anything, remove it: straight beats stepped. Review question per
  corner: "what does this corner avoid?" The anchor rules ALWAYS win over straightness:
  never slide an anchor toward a corner of a shape to straighten an edge, and a corner
  caused by keeping a centred or padded anchor is a caused corner.
- **Prefer: same-direction edges share anchors.** Edges leaving or entering one shape in
  the same direction share one anchor point, or a tight cluster on that side: at most one
  anchor per side unless directions genuinely differ.
- **Every edge pins its route.** Connection points are fixed in the edge's style
  (`exitX`/`exitY`/`entryX`/`entryY`) and every jog is an explicit waypoint, never left
  for the router to invent. A pinned route is a literal polyline in the XML, so all the
  rules above are checked mechanically rather than by eye. When editing by hand in the
  draw.io UI, add corners with right-click and "Add Waypoint" (dragging a segment alone
  does not create one), and re-verify after moving any shape: pinned endpoints follow
  the shape while waypoints stay put, and the router bridges the gap with exactly the
  diagonals and stutters these rules forbid.

## Working size

A diagram's content aims to stay inside roughly 1300 x 800 model units, the size at
which default-font text is still legible at README column width. The budget is
ADVISORY: a nudge toward compactness, never a rule that outranks any other on this
page. What stays binding is the ban on squeezing: smaller fonts and higher resolution
both fail, since the displayed width is fixed and only the model size decides
legibility.

The golden precedence: the binding rules on this page outrank the budget. When labels,
padding or routing cannot satisfy their rules in the space available, the diagram GROWS
until they can. Shrinking anything below rule compliance is never the fix: follow the
rules no matter what, make things bigger until they hold, and the diagram comes out
with enough space and clarity on its own.

An overrun the binding rules force is accepted as it stands: the actor map's
full-anatomy mandate (every circuit, witness and ledger field on one diagram) pushes
the erc20-vault actor map to 1862 x 2468, and that size is sanctioned. An overrun
nothing forces is slack, and slack has three exits: tighten the layout, split the
content into more diagrams, or move sequencing to a mermaid diagram in the README.

## Iconography

Icons are a semantic layer: one concept, one icon, wherever that concept appears, and
this table is the whole mapping.

### The icon table

| Concept | Icon | Meaning |
|---------|------|---------|
| Ledger state | database cylinder, `shape=mxgraph.flowchart.database` | on-ledger state the contract reads and writes |
| Circuit | cog, `shape=mxgraph.ios7.icons.settings` | a circuit a caller invokes, pure circuits included |
| Witness | open eye, `diagram-assets/witness-icon.png` | a witness, the private input the proof observes |
| Secret | crossed eye, `diagram-assets/secret-icon.png` | a value that stays with its holder and never leaves it |
| Midnight lane | Midnight logo, `diagram-assets/midnight-logo.png` | the Midnight chain's swimlane |
| Signet lane | Sig Network logo, `diagram-assets/sig-network-logo.png` | a Signet-controlled contract's swimlane |
| Contract / dApp | `diagram-assets/contract-app.png` | a contract or dApp actor box |
| Wallet | `diagram-assets/wallet.png` | a wallet holding a party's keys, never a mere address on a chain (that is Account) |
| MPC server | `img/lib/allied_telesis/computer_and_terminals/Server_Desktop.svg` | one MPC server, and the cluster group built from three of them |
| Foreign chain | `img/lib/azure2/blockchain/Consortium.svg` | a non-Midnight chain's swimlane |
| Exchange contract | `diagram-assets/exchange-icon.svg` | a swap or exchange venue on a foreign chain (the Uniswap router) |
| Token contract | `diagram-assets/token-contract-icon.svg` | a token contract on a foreign chain (the ERC20 token, the Aave stata token) |
| Account | `diagram-assets/wallet-icon.svg` | an address holding a balance on a chain, never a party's key-holding wallet (that is Wallet) |

The open eye and the crossed eye are a deliberate pair: the witness observes, the
secret stays hidden. A new icon lands as one row here plus one entry in the palette
card's Iconography section, and both land in the same change.

### The icon bank

[diagram-assets/](diagram-assets/) holds the custom icons, pre-sized for embedding, and
the generic ones are draw.io built-in library references. When an icon changes, update
the bank file, the palette card, and every diagram embedding it in the same change.

## Curated layouts

A diagram carrying the curation marker (an inert model cell with id `curated`, added
with the `curate` command of [draw-io-cli](https://github.com/BRBussy/draw-io-cli)) has a
hand-tidied layout, and that layout is
authorial. On a curated diagram, an edit changes ONLY the cells its task names: the
geometry, routing, label seats and spacing of everything else are the curator's
decisions, and this page's layout preferences (working size, corner causes, circle
seats and their kin) defer to them. Lint findings that predate an edit are standing
curatorial choices: they are reported, never fixed unbidden. The semantic rules bind
as ever: names come from code, membership comes from the census, and the truth
priority is unchanged.

The mandate is proven, never trusted: an edit to a curated diagram keeps a copy of
the file from before the edit and finishes with that tool's `guard-diff` command over
the before and after copies, allowing exactly the cells the task authorised, and a
violation is reverted rather than allowed after the fact.
Only the curator adds or removes the marker, and a marking change re-renders the
pair so the PNG's embedded model carries the same state.

## Editing workflow

1. Edit the `.drawio` source, copying styles and icons from the palette card.
2. Render the PNG from the source, with the settings in the draw.io config file.
3. Look at the rendered PNG before committing. Broken edge labels, escaped containment
   and missing icons are all visible at a glance and invisible in the XML.
4. Commit the `.drawio` and `.drawio.png` together.

### Flow diagrams: the sequence form

The five flow diagrams use a sequence form: one lifeline per actor, tinted bands per
phase, one row per arrow, a branch as one circle with two arms, the key derivations as
a footnote. They carry no curation marker.
