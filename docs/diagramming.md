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

- Circuit labels render as code: Menlo/Monaco monospace at 12px, the keyword
  (`circuit`) in `#AF00DB`, the identifier in `#202020`. Copy the sample cell from the
  palette card.
- Circuit, event and ledger-field spellings come from the contract source, step phrasing
  comes from the README. One exemption to the greppable-name rule: the generic protocol
  diagram (`sign-bidirectional-flow.*`) depicts a hypothetical integrating contract, so
  its placeholder circuits (`startCrossChain(...)`, `completeCrossChain(...)`) grep
  nowhere by design. Every real name in it (events, singleton circuits, ledger fields)
  still must grep.
- An edge label's subject is the acting party: an actor (`MPC:`, `User:`), a wallet
  (`User's Midnight wallet:`), a lane (`dApp/relayer:`) or a circuit
  (`startCrossChain circuit:`). The subjects in use are listed in the config's
  `lint.subjects`, and a new subject lands there in the same change as its first label.

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

The actor map's full-anatomy mandate pushes the erc20-vault actor map to 1825 x 1648
model units, and that overrun of the working-size budget is sanctioned.

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

The committed flow diagrams and the actor map carry the curation marker, so an edit to
any of them follows the style guide's curated-layout mandate: change only the cells the
task names and prove it with `guard-diff`.
