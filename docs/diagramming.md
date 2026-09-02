# Diagram style guide

Every draw.io diagram in this repository follows the conventions on this page. The palette
card at [diagram-palette.drawio.png](diagram-palette.drawio.png) shows each convention
rendered, and its source [diagram-palette.drawio](diagram-palette.drawio) is the copy
source: take styled cells from it rather than restyling by hand.

## File format

A diagram is a committed pair:

- `<name>.drawio`: the XML source of truth. Text, so PR diffs show which labels and edges changed.
- `<name>.drawio.png`: what READMEs embed, rendered from the source. The render embeds the
  model in the PNG, so the PNG alone stays openable and editable in VS Code's draw.io extension.

Render settings live in the repo's draw.io config file, [drawio.config.json](../drawio.config.json).
Resolution changes are edits to that file (`render.scale`), re-rendering every pair in the
same change. The pair moves together: re-render after every source edit, and commit both.
Draw.io SVG exports depend on the viewer's theme and render broken in dark mode, so READMEs
embed the PNG and never an SVG.

**TIP:** If you are using Claude Code you can ask it to edit and render diagrams for you.
It has a skill for this workflow and will extract, edit, render and visually verify the
result on your behalf.

## Colour palette

Colours mean protocol phases. Everything that belongs to one step, the numbered
circle and every arrow of that step, uses its phase's colour, and nothing else does. Step
numbers are ordinals per diagram, 1..N in that flow's execution order, so a phase keeps
its colour in every diagram whatever number it carries there. The fund phase is the
user's own wallet moving value on the foreign chain before any contract is involved, and
it appears only in flows that begin with such a transfer.

| Phase | Colour |
|-------|--------|
| fund | `#008695` |
| request | `#E73F74` |
| signature | `#3969AC` |
| broadcast | `#11A579` |
| attestation | `#FDAE61` |
| settle | `#7F3C8D` |

Everything else stays neutral: default black strokes on a white background, swimlanes and
shapes unfilled.

## Visual weight is semantics

Three visual channels carry meaning, and each is reserved for exactly that meaning:

- **Dotted outlines mark connectable nodes.** Ledger state, circuits and behaviour
  responsibilities render in dotted-border boxes, and edges anchor only to nodes
  (outlined boxes, icons, hexagons, actor boxes, lanes). Borderless text is
  annotation: it rides an edge and never takes an arrow.
- **Bold marks the greppable name.** In prose (edge labels, notes), the verbatim
  names that grep in source (events, circuits, keys, ledger fields) are bold, plus
  exactly two structural classes: an edge label's acting-party prefix and a note's
  colon-led keywords. Nothing else is bold, verbs included: bold text is the
  visible anchor tying the diagram to the code, and the two structural classes are
  the scaffolding around it.
- **Arrow flow marks sequence.** When one lane performs an ordered sequence within a
  step, the sequence is drawn as edges threading through its boxes in the step's
  colour, entering the first box and leaving the last toward its destination. Boxes
  with only sideways edges hide their order.
- **Broad dashes mark derivation machinery.** Key-derivation notes and identity
  nodes carry a broad-dashed border (`dashed=1;dashPattern=12 12`), and every
  derivation edge is a broad-dashed line (`dashPattern=8 8`, `strokeWidth=2`).
  Nothing else uses broad dashes: the actor cluster's plain dashed rectangle
  and the dotted node borders stay visually distinct from it.

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
  canonical step strings render only on the flow page (its step-list bullets and
  mermaid notes). The diagram-to-page link is the ordinal set: the circles' numbers
  are exactly the frozen strings' ordinals, a branch's arms sharing one ordinal with
  one circle per arm. Every step arrow DESCRIBES itself: each logical arrow of a
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
verb lands as one row here (verb, who says it, exact meaning), in the same change as
its first label, keeping one verb one meaning.

## Shapes

- Swimlane per chain or system, nested swimlanes for contracts. Every lane header
  shows ONE centred unit: the lane's icon, a small gap, then the bold title, centred
  horizontally and vertically in the header band. The single exception: a contract
  lane whose address participates in key derivation carries its broad-dashed
  identity node horizontally centred directly below the header unit. The lane cell's own
  value stays empty: the unit is a group (icon + title text) copied from the palette
  card and centred at the lane's midpoint. A lane whose logo includes its wordmark
  (Midnight) uses the logo alone as the unit. Each lane's icon comes from the
  [iconography table](#iconography).
- The MPC lane draws its servers as the palette's server-cluster group, three server
  towers around the Sig Network roundel. The cluster sits horizontally CENTRED in the
  lane when nothing shares its vertical band. When other content overlaps that band
  on one side within the minimum padding, the cluster moves to the top corner AWAY
  from it (content on the left pushes it top-right, content on the right pushes it
  top-left). The lane's width is minimised: just wide enough that reasonable padding
  (15 units or more) separates the lane's widest text (header unit, behaviour notes)
  from the cluster and the border. Dead space is the defect: shrink the lane rather
  than stretching content to fill it, and the vertical gap between the cluster and
  the note column below it matches the note-to-note gap, so the lane keeps one
  rhythm.
- Plain rectangle (`rounded=0`, bold) for actors and apps, with the app's icon
  embedded INSIDE the box, so the box reads as a component. The icon's placement
  follows the box's height, and the height follows what the box has to serve:
  - **Beside the text** where the box hugs its label. The icon sits 12 units in
    from the left and is vertically centred, `spacingLeft` clears the text past it
    (34 units for a 26-unit icon), and 12 units of padding surround the pair: an
    actor box is no taller or wider than that. This is the default.
  - **Above the text** where edges anchor to the box at fractions of its height and
    force it taller than its label needs. Filling that height beside the text
    strands the remainder as dead space, so the icon goes on the horizontal centre
    line with `spacingTop` dropping the text clear beneath it.

  Either way the icon and text read as ONE unit centred on both axes, and the unit
  is what gets centred, never the icon and the text apart. Whatever the cell
  constants give, at least 8 model units of clear space separate the icon's
  rendered ink from the first text glyph, judged on the RENDER and never on cell
  geometry alone, since icons fill their cells unevenly. A gap that comes up
  short is fixed by widening the box, as width is what buys the gap under
  centred text: the icon never shrinks and the text never slides off its
  centring. The reference look is the lane header unit's gap between icon and
  title. Two cautions when
  placing it: centre the icon on its rendered INK, not on its cell box, since an
  embedded PNG usually carries uneven transparent padding (the contract/dApp icon
  runs about 5 units light on the right, so its cell sits 1 unit right of centre);
  and `spacingTop` does not move the text one-for-one, so set it by measuring the
  render rather than by arithmetic. The caption-above rule applies to standalone
  icons only.
- The User actor is the composite group from the palette card: bold caption above,
  the blue person shape behind, the wallet icon in front.
- Hexagon for events, hugging its two-row label (`Event` over the bold name): the
  text is centred on both axes, the sloped sides run at 45 degrees (`fixedSize=1`
  with `size` equal to half the hexagon's height), and the hexagon is sized so the
  text clears the slopes by the uniform padding and no more. Excess width or height
  around a centred label is dead space, and a width-relative slope is forbidden:
  it forces wide hexagons to grow instead of hug.
- Dotted-bordered text box (`dashed=1;dashPattern=1 2;strokeColor=default`) for
  behaviour responsibilities: they are nodes and edges land on them. Sibling
  responsibilities share one colon-led scaffold (`Signs: <object> With:
  <instrument>`) and their boxes left-align on ONE shared x, so the opening
  verbs read as a column down the page whatever width each box takes. The
  greppable instrument is bold.
  A note stacks as many colon-led pairs as the behaviour needs (`Reads:
  <object> On: <trigger>`, `Attests: <object> With: <instrument>`), each
  keyword bold, colon-terminated, opening its own line.
- Contract-member nodes (ledger state, circuits) are grouped cells: a
  dotted-border box, a text-height icon inside it at the left, and the member's
  code text beside the icon, grouped so they move as one. The icon is 16 units
  tall and is the one the [iconography table](#iconography) gives that member
  kind. The icon sits 8 in from the border with a 6-unit gap before the text.
  The code text opens with the compact keyword (`ledger`, `circuit`,
  `pure circuit`, `witness`) in the code style's
  keyword colour, ALWAYS at normal weight: keywords are never bold. Bold is
  reserved for the greppable name, the thing that greps in the contract
  source, and a keyword is syntax, not a name. A record or map type is a record block: bold type name with
  its opening brace, fields indented beneath, closing brace. A scalar field is
  its single line.
- Contract members stack in vertically separated SECTIONS, in fixed order:
  ledger, witness, circuits, pure circuits (present only case by case). The
  gap between sections is visibly larger than the row gap inside a section,
  one consistent section gap per diagram, so the grouping reads without
  labels.
- An identity secret renders as the palette's secret-node sample: a
  dotted-border box, the secret icon the [iconography table](#iconography)
  names, and the value's env-var name in Menlo bold.
- **Key derivation renders as a keyDerivation note plus broad-dashed edges.**
  The note is a broad-dashed box carrying the abstract call
  `keyDerivation(<version>, <inputs...>, <path>)`, one argument per line.
  `keyDerivation` greps nowhere by design (it stands in for the SDK's
  derivation functions, which the docs name). Every argument token that greps
  in source (env-var names, circuit names, path literals) is bold, the rest
  is not. A root key or contract address that participates in derivation
  renders as a broad-dashed identity node carrying its env-var name in bold.
  Derivation edges are broad-dashed and every arrow points at the thing
  generated or used: input nodes point INTO the note, and the note points at
  what its call derives.
- A circuit's behaviour is a bullet list inside that circuit's dotted box, never a
  separate floating note.
- Dashed no-fill rectangle for an actor cluster: it draws a visible dashed outline
  around the shapes that act as one party (the User composite with its wallets).
- Broad-dashed edge (`dashPattern=8 8`) for key derivations, copied from the
  palette's derivation sample.
- Circle (`strokeWidth=2`, font size 20) for step numbers, in the step's colour.

## Layered composition (NEVER BREAK)

A diagram is composed in layers, and each layer must stand on its own:

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
(every exported circuit, every witness and every ledger field) and the full
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
appears on the actor map alone. Membership, for members and actors alike, is
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
the name shares the `From:` line (`From: signBidirectionalEventMap`), and
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
the erc20-vault actor map to 1825 x 1648, and that size is sanctioned. An overrun
nothing forces is slack, and slack has three exits: tighten the layout, split the
content into more diagrams, or move sequencing to a mermaid diagram in the README.

## Iconography

Icons are a semantic layer: one concept, one icon, wherever that concept appears. The
mapping belongs to the concept and not to any one cell type, so the icon that marks a
ledger member in a diagram is the icon that marks a ledger topic in prose. This table
is the whole mapping, and nothing else in this guide restates which icon a shape
carries.

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
secret stays hidden.

Colour marks rank: top-level actors carry the coloured icons, and supporting
actors and contract members carry the black-and-white ones, so an icon's colour
alone says whether its bearer leads the diagram or supports it.

The table is the extension point. A new icon lands as one row here plus one entry in
the palette card's Iconography section, and both land in the same change.

### The icon bank

Icons come from the bank, never from ad hoc downloads:
[diagram-assets/](diagram-assets/) holds the custom icons, pre-sized for embedding, and
the generic ones are draw.io built-in library references. Custom icons are embedded into
each diagram as base64 copies of the bank files, which keeps every diagram
self-contained and portable. Copy the icon cells from the palette card's Iconography
section rather than re-encoding the files. An Iconography entry is a captioned card
exhibit: when copying it into a diagram, take the cell's style byte-identically and
leave the destination cell's value empty, so the caption stays on the card (the
label-position tokens the style carries are inert on a cell with no value). When an
icon changes, update the bank file, the palette card, and every diagram embedding it
in the same change.

## Editing workflow

1. Edit the `.drawio` source, copying styles and icons from the palette card.
2. Render the PNG from the source, with the settings in the draw.io config file.
3. Look at the rendered PNG before committing. Broken edge labels, escaped containment
   and missing icons are all visible at a glance and invisible in the XML.
4. Commit the `.drawio` and `.drawio.png` together.
