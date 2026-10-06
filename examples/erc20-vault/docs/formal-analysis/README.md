# Formal analysis of the ERC20 vault

LaTeX source of the security analysis. `main.tex` is the root, each section
is its own file, `macros.tex` holds the notation and `references.bib` the
bibliography.

The document analyses the vault contract at release tag `erc20-vault-v0.3.0`
(whose contract source is byte-identical to the one tagged `erc20-vault-v0.1.0`
and `erc20-vault-v0.2.0`). The latest release is `erc20-vault-v0.4.0`: the
paragraphs headed "Differences with the latest release" describe what changed.
Both tags are defined once, in `macros.tex` (`\analysedTag` and `\latestTag`),
and every link in the document is built from them.

## Build

With TeX Live on the path:

```bash
latexmk -cd examples/erc20-vault/docs/formal-analysis/main.tex
```

`.latexmkrc` selects xelatex and runs BibTeX. `main.pdf` is committed, the
intermediates are ignored.
