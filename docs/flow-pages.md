# Flow pages

A flow page is the markdown walkthrough beside a flow diagram:
`examples/<example>/docs/<flow>/<flow>.md`, committed beside `<flow>.drawio`
and `<flow>.drawio.png`. The page DESCRIBES the flow. It is not a second copy
of the code: a reader who wants implementation detail follows the page's links
into the contract source and the flow files, where the code and its comments
are the single telling.

## Page structure

Top to bottom:

1. `# <Flow>` title and a short intro paragraph saying what the flow moves and
   in which direction.
2. Pointers to the protocol and integration material (the repo README's sign
   bidirectional flow section and integration guide).
3. The embedded diagram: `![<Flow> flow](<flow>.drawio.png)`.
4. The step list (next section).
5. Any shared-setup notes the steps reference, kept short, links over code.
6. A `## Sequence` section holding the mermaid sequence diagram whose
   `Note over` lines carry the canonical step strings.

## The step list

After the diagram, ONE flat list describes the whole flow, introduced by a
line in the shape "As illustrated, the flow comprises N steps:". Each step is
one top-level bullet with indented detail bullets:

- A top-level bullet reads `- **N.** <headline>`: a dash bullet, the step
  ordinal bold with a trailing dot, then the headline. The headline is one
  clear, concise sentence saying what the step does, and it carries the flow's
  canonical step string: the ordinal matches the string's `Step N` and the
  headline text is byte-equal to the string's tail after `Step N: `.
- Detail bullets sit under the headline as dash bullets indented two spaces.
  They lay out the mechanism: what is constructed, stored, emitted, verified,
  and by whom.
- The manual bold number is deliberate. Markdown renderers indent nested dash
  bullets reliably, while `1.` ordered lists lose their nesting in several
  renderers, so the list is authored as dash bullets carrying their own bold
  ordinals.
- A branch's arms share one ordinal, one top-level bullet per arm, matching
  the diagram's captions.
- Names are verbatim from source under the truth priority code > README >
  diagram, key terms bold, and every claim links to where it lives: the
  circuit in the contract source, the flow function in
  `integration-tests/src/flows/`, the SDK symbol. Links replace quotation.

The golden specimen of this shape is the five-step list under the diagram in
the Sig Network Midnight Integration repository README's "Sign Bidirectional
Flow" section: match it down to the formatting of the points.

## Code snippets

The default number of code snippets on a flow page is zero. Implementation
lives in the contract source and the flow files, and the page links there. A
snippet earns its place only when prose genuinely cannot carry a specific
point (the argument order of a hash, a byte layout), and it is cut to the
lines that make that point.

## Correspondence

Every canonical step string appears exactly twice on its flow page: once as
its step-list bullet (`- **N.** <tail>` as above) and once on a `Note over`
line inside the mermaid fence. The flow page is where the canonical strings
render: the flow diagram carries no step text, and it links to the page by
the ordinal set, its numbered circles being exactly the frozen strings'
ordinals (a branch's arms share one ordinal, one circle per arm). Text on
the diagram's arrows is edge labels under the diagramming style guide's
golden rules, a separate vocabulary from the canonical strings.
