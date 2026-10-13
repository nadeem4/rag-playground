# pandion install check

This checks the `pandion` wheel the way a user would get it, before each release to PyPI. It
is not part of the uv workspace, and `uv run pytest` at the root does not run it.

`run_check.py` builds the wheel and makes two brand new virtual environments in a scratch
folder. Each one runs its tests from a copy in the scratch folder, so `import pandion`
finds the installed wheel and never the repo's source.

The first environment has the `pdfium` and `lancedb` extras. It leaves out `local` and
`docling`, so nothing pulls in torch and no model is downloaded. It runs
`test_installed.py`, which uses two bundled sample PDFs and the `fake-deterministic`
embedder. It checks that:

- `pandion` is imported from the new environment.
- One pipeline written three ways (YAML, a dict per stage, classes) gives the same
  graphs, the same artifact ids for the index, retrieval and the `search` answer step,
  and the same hits in the same order with the same scores.
- A pipeline written back with `to_yaml()` and read again gives the same ids.
- `pandion.parse`, `pandion.clean` and `pandion.chunk` work on their own, and
  `from pandion.parse import Pdfium` works.
- A second `index.run` on the same files is all cache hits.

The second environment has the base install only, with no extras. It runs
`test_base_install.py`, which checks that:

- `import pandion` and `pandion.plugins.discover()` work, and no extra is installed.
- The cleaners and chunkers run on a document built in the test.
- `pandion.parse(pdf, use="pdfium")` fails with the message the guide shows:
  `The pdfium parser needs pypdfium2. Install it with: pip install "pandion[pdfium]"`.
- An index run stops at the parser with that message, and skips the index step.
- The `lancedb` index step, called on its own, says to install `pandion[lancedb]`. A run
  cannot reach it without a parser extra.
- `pandion install pipeline.yaml --print` prints a pip command with the extras the file
  needs.

From the root of the repo:

```bash
uv run python checks/pandion-install/run_check.py
```

It needs network access to install the dependencies. The scratch folder is
`checks/pandion-install/.work/` (ignored by git and emptied on each run); pass
`--work <folder>` to use another one.

## The first model download

With `--with-models`, the first environment also gets the `local` extra (torch and
sentence-transformers) and runs `test_models.py`. It downloads `bge-small-en-v1.5`, the
smallest real embedder, about 130 MB, into a folder of its own. It checks that:

- With `download: never` and an empty folder, the embedder fails with an error that
  names the model and the folder, and nothing is downloaded.
- With `download: auto`, the model downloads into that folder on first use.
- A second run, in a new process with `HF_HUB_OFFLINE=1`, works from the folder with
  both `auto` and `never`, so it did not download again.

```bash
uv run python checks/pandion-install/run_check.py --with-models
```

This installs torch, so it is slow on a first run. The default run leaves it out.

## Before a release

The **Publish pandion** workflow builds the wheel once and tests that file, so the
wheel that reaches PyPI is the one that passed:

```bash
uv run python checks/pandion-install/run_check.py --wheel dist/pandion-0.1.0-py3-none-any.whl --tag pandion-v0.1.0
```

`--wheel` tests that wheel instead of building one. `--tag` first checks that the tag is
`pandion-v` and the version in `packages/pandion/pyproject.toml`, and stops if not.
