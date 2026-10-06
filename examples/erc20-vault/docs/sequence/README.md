# Flow diagram generator

`build_sequence.py` writes each `<flow>.drawio` from its data table `<flow>_data.py`.
The data table is the source of truth for the labels; the generator holds the layout
and copies styles and icons from `docs/diagram-palette.drawio`. Never edit a generated
`.drawio` by hand. The data format is described at the top of `build_sequence.py`.

Needs Python 3 with Pillow and the Helvetica and Menlo fonts (macOS, or `FONT_DIR`
pointing at a folder with both). From the repository root:

```sh
python3 examples/erc20-vault/docs/sequence/build_sequence.py \
  examples/erc20-vault/docs/sequence/deposit_data.py \
  examples/erc20-vault/docs/deposit/deposit.drawio
drawio-cli render examples/erc20-vault/docs/deposit/deposit.drawio --png
```

A clean build prints only the `wrote` line; fix every `WARN` in the data table first.
Commit the data table, the `.drawio` and the `.png` together, and keep the step
numbers equal to the page's step list.
