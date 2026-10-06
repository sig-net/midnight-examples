# Formal analysis of the ERC20 vault

LaTeX source of the security analysis. `main.tex` is the root, each section
is its own file, `macros.tex` holds the notation and `references.bib` the
bibliography.

## Build

The document is styled by the
[Sig.Network document template](https://github.com/sig-net/document-template),
which provides the `sig-brand` package, the Archivo fonts and the logo. Clone
it as a sibling of this repository (so that `../document-template` resolves
from the repository root), or point `SIG_DOCUMENT_TEMPLATE` at the checkout.
Then, with TeX Live on the path:

```bash
latexmk -cd examples/erc20-vault/docs/formal-analysis/main.tex
```

`.latexmkrc` selects xelatex, runs BibTeX and tells TeX where the template
lives. `main.pdf` is committed, the intermediates are ignored.
