# Formal analysis of the ERC20 vault

LaTeX source of the security analysis. `main.tex` is the root, each section
is its own file, `macros.tex` holds the notation and `references.bib` the
bibliography.

## Build

With TeX Live on the path:

```bash
latexmk -cd examples/erc20-vault/docs/formal-analysis/main.tex
```

`.latexmkrc` selects xelatex and runs BibTeX. `main.pdf` is committed, the
intermediates are ignored.
