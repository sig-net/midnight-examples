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

Colours mean protocol steps. Everything that belongs to runtime step N, the numbered
circle and every arrow of that step, uses that step's colour, and nothing else does.

| Step | Meaning | Colour |
|------|---------|--------|
| 1 | request | `#E73F74` |
| 2 | signature | `#3969AC` |
| 3 | broadcast | `#11A579` |
| 4 | attestation | `#FDAE61` |
| 5 | settle | `#7F3C8D` |

Everything else stays neutral: default black strokes on a white background, swimlanes and
shapes unfilled.

## Labels

- Prose labels use the default font (Helvetica).
- Circuit labels render as code: Menlo/Monaco monospace at 12px, the keyword (`circuit`)
  in `#AF00DB`, the identifier in `#202020`. Copy the sample cell from the palette card.

## Shapes

- Swimlane per chain or system, nested swimlanes for contracts.
- Plain rectangle (`rounded=0`, bold) for actors and apps.
- Hexagon for events.
- Dashed borderless text box for behaviour notes.
- Dashed edge for key derivations.
- Circle (`strokeWidth=2`, font size 20) for step numbers, in the step's colour.

## Layered composition (NEVER BREAK)

A diagram is composed in layers, and each layer must stand on its own:

1. **Layer 1: shapes and their labels.** Boxes, hexagons, icons, notes. Composed FIRST,
   as a deliberate arrangement: siblings align on shared coordinates (the circuits inside
   a contract stack at one x with even vertical spacing), gaps are consistent, captions
   sit where the caption rule says. The test: delete every line from the diagram and what
   remains still looks intentionally placed. A layer-1 item never sits somewhere that only
   makes sense once the lines are drawn (an indented circuit "making room" for an edge is
   a defect: the edge routes around, the circuit stays in its column).
2. **Layer 2: lines and step circles.** Routed around layer 1 per the edge rules below.
3. **Layer 3: line text.** Edge labels annotate layer 2 without colliding with either layer.

## Captions and anchors

- **An icon's caption sits above the icon, centred** (text before image), everywhere:
  actors, servers, chains, the lot.
- **Edges anchor at the centre of the side they meet** (`0.5` on that axis). Never anchor
  at or near a corner of a text or image bounding box. On a shape taller than one line of
  text an off-centre anchor is allowed, but it keeps clear padding from the shape's edge,
  never hugging it.

## Edge routing (NEVER BREAK)

- **NO diagonal segments, ever.** Every edge is built from strictly horizontal and
  strictly vertical runs joined by clean 90 degree corners.
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
- **A step never crosses itself.** Two edges of the same colour must not cross each
  other. When two edges share a source shape, order their anchors to match their targets
  so they fan out without crossing. A T-junction off a shared trunk is the sanctioned
  form of fan-out. Where different steps must cross, put `jumpStyle=arc` on the crossing
  edge so the crossing reads as a jump, never as a junction.
- **Every edge pins its route.** Connection points are fixed in the edge's style
  (`exitX`/`exitY`/`entryX`/`entryY`) and every jog is an explicit waypoint, never left
  for the router to invent. A pinned route is a literal polyline in the XML, so all the
  rules above are checked mechanically rather than by eye. When editing by hand in the
  draw.io UI, add corners with right-click and "Add Waypoint" (dragging a segment alone
  does not create one), and re-verify after moving any shape: pinned endpoints follow
  the shape while waypoints stay put, and the router bridges the gap with exactly the
  diagonals and stutters these rules forbid.

## Working size

A diagram's content stays inside roughly 1300 x 800 model units, the size at which
default-font text is still legible at README column width. A diagram that outgrows the
box gets split into more diagrams (or its sequencing moves to a mermaid diagram in the
README), never squeezed: smaller fonts and higher resolution both fail, since the
displayed width is fixed and only the model size decides legibility.

## Icons

Icons come from the bank, never from ad hoc downloads:

- [diagram-assets/](diagram-assets/) holds the custom icons, pre-sized for embedding:
  `midnight-logo.png`, `sig-network-logo.png`, `contract-app.png`, `wallet.png`.
- Generic icons are draw.io built-in library references
  (`img/lib/allied_telesis/computer_and_terminals/Server_Desktop.svg` for MPC servers,
  `img/lib/azure2/blockchain/Consortium.svg` for a foreign chain).

Custom icons are embedded into each diagram as base64 copies of the bank files, which
keeps every diagram self-contained and portable. Copy the icon cells from the palette
card rather than re-encoding the files. When an icon changes, update the bank file,
the palette card, and every diagram embedding it in the same change.

## Editing workflow

1. Edit the `.drawio` source, copying styles and icons from the palette card.
2. Render the PNG from the source, with the settings in the draw.io config file.
3. Look at the rendered PNG before committing. Broken edge labels, escaped containment
   and missing icons are all visible at a glance and invisible in the XML.
4. Commit the `.drawio` and `.drawio.png` together.
