# pandion install check

This checks the `pandion` wheel the way a user would get it, before it goes to PyPI. It
is not part of the uv workspace, and `uv run pytest` at the root does not run it.

`run_check.py` builds the wheel, makes a brand new virtual environment in a scratch
folder, and installs the wheel there with the `pdfium` and `lancedb` extras. It leaves
out `local` and `docling`, so nothing pulls in torch and no model is downloaded. Then it
runs `test_installed.py` inside that environment, from a copy in the scratch folder, so
`import pandion` finds the installed wheel and never the repo's source.

The tests use two bundled sample PDFs and the `fake-deterministic` embedder. They check
that:

- `pandion` is imported from the new environment.
- One pipeline written three ways (YAML, a dict per stage, classes) gives the same
  graphs, the same artifact ids for the index, retrieval and the `search` answer step,
  and the same hits in the same order with the same scores.
- A pipeline written back with `to_yaml()` and read again gives the same ids.
- `pandion.parse`, `pandion.clean` and `pandion.chunk` work on their own, and
  `from pandion.parse import Pdfium` works.
- A second `index.run` on the same files is all cache hits.

From the root of the repo:

```bash
uv run python checks/pandion-install/run_check.py
```

It needs network access to install the dependencies. The scratch folder is
`checks/pandion-install/.work/` (ignored by git and emptied on each run); pass
`--work <folder>` to use another one.
