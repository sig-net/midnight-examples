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
