# The pandion package

Pandion (a working name) is the engine of RAG Playground as a Python package. The
playground runs on it. Every stage can be run and inspected on its own, and a whole
index can be built from one config file. Each step's result is cached under a hash of its
recipe, so the same files with the same settings are never processed twice.

Coming next: search, rerank, ask and sync. This guide covers what exists today: parse,
clean, chunk and the index.

## Contents

- [Install](#install)
- [Try one stage at a time](#try-one-stage-at-a-time)
- [The pipeline file](#the-pipeline-file)
- [Build an index](#build-an-index)
- [The cache](#the-cache)
- [Models](#models)
- [Install what a file needs](#install-what-a-file-needs)
- [Errors](#errors)
- [Run the example](#run-the-example)

## Install

Pandion is not on PyPI yet. Install it from a clone of the repo. It needs Python 3.13.

```bash
git clone https://github.com/nadeem4/rag-playground.git && cd rag-playground
pip install "./packages/pandion[pdfium,lancedb,local]"
```

The base install is small. Each parser, store and model library is an extra:

| Extra | What it brings | Needed by |
|---|---|---|
| `pdfium` | pypdfium2 | the `pdfium` parser |
| `docling` | Docling and its OCR engine | the `docling` parser |
| `local` | sentence-transformers and torch | the `qwen3-embedding-0.6b` and `bge-small-en-v1.5` embedders |
| `lancedb` | LanceDB and pyarrow | the `lancedb` index |

The cleaners and the chunkers need only the base install. The `fake-deterministic`
embedder needs no extra and no download, so it is good for trying things out.

Inside the repo, `uv sync --extra dev` installs the package with the extras the app
uses, and `uv run` then finds it.

## Try one stage at a time

These calls run one strategy directly. They use no pipeline and keep no cache. Each one
returns a `StageResult` with `.output`, `.note` (one sentence about what the stage did)
and `.duration_ms`.

```python
import pandion

pdf = "samples/chunking-primer/chunking-primer.pdf"   # in the repo

parsed = pandion.parse(pdf, use="pdfium")
print(len(parsed.output.elements), "blocks,", parsed.output.page_count, "pages")

cleaned = pandion.clean(parsed, steps=[{"use": "dedupe_blocks"}])
print(cleaned.note)

chunks = pandion.chunk(cleaned, use="recursive_character", chunk_size=400)
print(len(chunks.output.chunks), "pieces")
print(chunks.output.chunks[0].text)
```

The sample PDFs live in `samples/`, one folder each: `chunking-primer`,
`two-column-report`, `table-of-figures` and `scanned-notes`.

A strategy's settings are keyword arguments, with the same names as in the app's
settings forms. `clean` takes a list of steps and runs them in the order given. Each step
names its cleaner with `use` and holds its settings beside it, for example
`{"use": "drop_matching", "pattern": "Draft"}`. Its note has one line per step, saying
what it removed. `clean` and `chunk` accept either a parsed document or the result of
the stage before, as above.

## The pipeline file

A pipeline file says how to build an index. This is the full format, with every field
the package reads.

```yaml
# pipeline.yaml

# Required. Pandion keeps three folders here: sources/ (each file once),
# artifacts/ (the cache) and embeddings/ (the embedding cache).
# A relative path is read from the folder this file is in.
path: ./my-index

# Optional. How local models are found and loaded. None of this changes a result,
# so it is never part of a recipe hash.
models:
  cache_dir: ./models   # where models are kept; default is the Hugging Face folder
  download: auto        # auto downloads a model on first use; never only loads one on disk
  device: auto          # auto, cpu, cuda or mps

index:
  parse:                # required
    use: pdfium         # pdfium or docling
  clean:                # optional; a list, run in order
    - use: dedupe_blocks   # also header_footer_strip, drop_matching
  chunk:                # required
    use: recursive_character
    chunk_size: 400     # any other key is a setting of this chunker
  embed:                # required
    use: qwen3-embedding-0.6b   # or bge-small-en-v1.5, fake-deterministic
    truncate_dim: null  # optional
  store:                # required
    use: lancedb        # the only store for now
    metric: cosine      # optional
    build_fts: true     # optional
```

Every key under a step, other than `use`, is a setting of that step. The names are the
ones in the app's settings forms, so the same pipeline built in the app and written in a
file gives the same artifact ids and shares a cache. [Strategies](strategies.md) lists
every step and setting. The chunkers are `recursive_character`, `markdown_header`,
`token_based`, `layout_blocks` and `sentence_window`.

`embed` and `store` are one step when it runs, because the index embeds the pieces as it
writes them.

## Build an index

```python
from pandion import Pipeline

report = Pipeline.from_file("pipeline.yaml").index.run("docs/")
```

`from_file` reads and checks the file; nothing runs yet. `run` takes a file, a folder or
a list of both. A folder gives every file under it except hidden ones. Each document is
named by its path inside the folder with forward slashes, such as `guides/chunking.pdf`.
A file given by itself is named by its file name.

The report holds:

- `report.documents`, a dict from document name to a `DocumentReport`. Its `.stages`
  has one `StageResult` for each step, under the names `source`, `parse`, `clean.1`
  (then `clean.2` and so on), and `chunk`.
- `report.index`, the `StageResult` of the index. Its `.output` is the index folder.
- `report.ok`, which is false if any step failed.

```python
report.documents["guides/chunking.pdf"].stages["chunk"].output   # the pieces
report.documents["guides/chunking.pdf"].stages["clean.1"].note   # what the cleaner removed
report.index.output                                              # the index folder
```

Each `StageResult` also has `status` (`executed`, `cached` or `failed`), `artifact_id`
(the recipe hash it is stored under), `duration_ms`, `note` and `error`. A step that
fails is reported, not raised, and the steps after it are skipped.

## The cache

An artifact's id is a hash of its recipe: the strategy, its settings and its inputs. Run
the same files with the same pipeline file again and every step is read from the
`artifacts/` folder instead of being run. The second run's statuses are all `cached`.

Change one setting and only the steps from that point on run again. Changing
`chunk_size`, for example, reuses the parse and the clean, and builds new pieces and a
new index. The embedding cache also keeps each embedding by the model and the text, so a
text is embedded once.

[Architecture](architecture.md#artifacts-and-the-cache) explains the hash in detail.

## Models

The local embedders (`qwen3-embedding-0.6b` and `bge-small-en-v1.5`) use a model from
Hugging Face. `models.download` decides what happens when it is not on disk yet.

- `auto` downloads the model the first time it is used.
- `never` only loads a model that is already in the folder. If it is missing, the run
  stops with an error that names the model and the folder. Use this on a server with no
  network. Download the model once with `auto`, or copy it into the folder.

`models.cache_dir` is the folder models are kept in. When it is empty, the Hugging Face
default is used, and the `HF_HOME` variable moves that. `models.device` picks where a
model runs: `auto` tries cuda, then mps, then cpu.

To load the default embedder before the first run, so that run does not wait, call
`pandion.preload_embedder("qwen3-embedding-0.6b")`. It takes the same settings as
`pandion.ModelSettings(download=..., device=..., cache_dir=...)`.

## Install what a file needs

Nothing is ever installed while a pipeline runs. To install the extras a pipeline file
needs, run:

```bash
pandion install pipeline.yaml
```

It reads the file, works out the extras its steps use, and runs `pip install` for them
in the Python that runs it. With `--print`, it only prints the command:

```bash
pandion install pipeline.yaml --print
```

## Errors

A pipeline file is checked before anything runs. A wrong step or setting is an error that
names where it is and what is accepted. For example, a misspelt setting:

```text
index.chunk (recursive_character) has no setting 'chunk_sise'. Its settings are: chunk_size, chunk_overlap, heading_context.
```

An unknown strategy lists the ones there are:

```text
index.chunk uses 'fixed', which is not a chunk strategy. The chunk strategies are: layout_blocks, markdown_header, recursive_character, sentence_window, token_based.
```

The same checks apply to `pandion.parse`, `pandion.clean` and `pandion.chunk`, where the
message starts with "The chunker" or "Clean step 1" instead of the place in the file. A
pipeline file problem is a `pandion.config.ConfigError`.

A missing extra says which one to install:

```text
The pdfium parser needs pypdfium2. Install it with: pip install "pandion[pdfium]"
```

That is a `pandion.errors.MissingExtra`, an `ImportError`. With `download: never`, a
model that is not on disk raises `pandion.models.ModelNotDownloaded`.

## Run the example

[`examples/pandion/`](../examples/pandion) has a small pipeline file and a script that
indexes two sample PDFs, prints each step's note, then runs again to show every step was
reused. A test runs it, so it stays correct.
