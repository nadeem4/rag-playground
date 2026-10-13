# The pandion package

Pandion is the engine of RAG Playground as a Python package. The
playground runs on it. Every stage can be run and inspected on its own, and a whole
index can be built from one config file. Each step's result is cached under a hash of its
recipe, so the same files with the same settings are never processed twice.

This guide covers what exists today: parse, clean, chunk, the index, keeping an index up
to date, the rewrite of a question, searching an index with rerankers, asking a question,
and three ways to write the same pipeline: a YAML file, a dict per stage, and classes in
code.

Before each release to PyPI, [checks/pandion-install/](../checks/pandion-install)
installs the built package in new environments, with and without extras, and tests it there.

## Contents

- [Install](#install)
- [Try one stage at a time](#try-one-stage-at-a-time)
- [Rewrite a question](#rewrite-a-question)
- [The pipeline file](#the-pipeline-file)
- [Build an index](#build-an-index)
- [Keep an index up to date](#keep-an-index-up-to-date)
- [Search an index](#search-an-index)
- [Ask a question](#ask-a-question)
- [Three ways to write a pipeline](#three-ways-to-write-a-pipeline)
- [The cache](#the-cache)
- [Models](#models)
- [Install what a file needs](#install-what-a-file-needs)
- [Errors](#errors)
- [Run the example](#run-the-example)

## Install

Pandion is [on PyPI](https://pypi.org/project/pandion/). It needs Python 3.13.

```bash
pip install "pandion[pdfium,lancedb,local]"
```

To try the examples in this guide, which use the bundled sample PDFs, clone the repo too:
`git clone https://github.com/nadeem4/rag-playground.git`.

The base install is small. Each parser, store and model library is an extra:

| Extra | What it brings | Needed by |
|---|---|---|
| `pdfium` | pypdfium2 | the `pdfium` parser |
| `docling` | Docling and its OCR engine | the `docling` parser |
| `local` | sentence-transformers and torch | the `qwen3-embedding-0.6b` and `bge-small-en-v1.5` embedders, and the `mmr` and `cross_encoder` rerankers |
| `lancedb` | LanceDB and pyarrow | the `lancedb` index and the `dense`, `bm25` and `hybrid_rrf` retrievers |
| `anthropic` | the Anthropic SDK | `llm_rewrite`, `llm_rerank` and `chat` with a Claude model |
| `openai` | the OpenAI SDK | `llm_rewrite`, `llm_rerank` and `chat` with an OpenAI model, OpenRouter or a custom endpoint |

The cleaners, the chunkers, the `text` query step and the `search` answer step need only the base install. The `fake-deterministic`
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

## Rewrite a question

The query step turns a question into the query that retrieval searches with.
`pandion.rewrite` runs one on its own and returns a `StageResult` whose `.output` is a
`Query`.

```python
import pandion

typed = pandion.rewrite("Who is my current employer?", use="text")
print(typed.output.text)          # the question, as typed

rewritten = pandion.rewrite(
    "Who is my current employer?",
    use="llm_rewrite",
    model="claude-haiku-4-5",
    style="keywords",             # or "document words", the default
    doc=parsed,                   # optional: the model reads the start of the document
    credentials={"anthropic_api_key": "sk-ant-..."},
)
print(rewritten.output.text)      # the model's words, which retrieval searches with
print(rewritten.output.asked)     # the question as typed, which the answer uses
print(rewritten.note)             # Rewrote the question as: ...
```

`llm_rewrite` asks a chat model to restate the question in the words the document would
use, so keyword search can find a passage that shares no word with the question. It makes
one model call each time and is never cached. If the reply is empty, too long or more than
one line, the question is used as typed and the note says so.

The `model` setting picks the model. The settings have the same names as in the app:

- a Claude model (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`) needs
  `anthropic_api_key` in `credentials`;
- an OpenAI model (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-luna`) needs `openai_api_key`;
- `openrouter` needs `openrouter_model` (an OpenRouter model id, such as
  `openai/gpt-4o-mini`) and `openrouter_api_key`;
- `custom` is any OpenAI-compatible server, such as Ollama. It needs `custom_base_url`
  (for example `http://localhost:11434/v1`) and `custom_model`. Its key,
  `custom_api_key`, is optional.

A key is never a setting. It goes in `credentials`, so it is never part of a recipe hash,
an artifact or a note, and every error message has it removed. Pandion does not read keys
from the environment; read the key yourself and pass it in.

If you serve pandion to people you do not trust, run the graph with
`pandion.executor.run(..., context_extras={"public_endpoints_only": True})`, or call
`pandion.llm.complete(..., public_only=True)`. A custom endpoint must then be a public
https address, so a stranger cannot point the server at its own network. The playground's
hosted demo does this. `pandion.rewrite` is for trying a step yourself and leaves it off.

## The pipeline file

A pipeline file says how to build an index, how to search it and how to answer. This is
the full format, with every field the package reads.

```yaml
# pipeline.yaml

# Required. Pandion keeps three folders here: sources/ (each file once),
# artifacts/ (the cache) and embeddings/ (the embedding cache), and after a
# sync, manifest.json (what the index was built from).
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

retrieve:               # optional; what p.retrieve runs
  rewrite: none         # optional; none, or a query step such as llm_rewrite
  search:               # required
    use: hybrid_rrf     # or dense, bm25
    top_k: 20           # how many pieces the search hands on
  rerank:               # optional; none, one step, or a list run in order
    - use: cross_encoder   # also mmr, llm_rerank
      top_k: 5

answer:                 # optional; what p.ask runs after retrieval
  use: search           # the pieces found, as they are; or chat
  top_k: 3
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

report = Pipeline.from_yaml("pipeline.yaml").index.run("docs/")
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

## Keep an index up to date

When files in a folder are added, changed or removed, sync the index with the folder:

```python
from pandion import Pipeline

report = Pipeline.from_yaml("pipeline.yaml").index.sync("docs/")
print("added", report.added)
print("changed", report.changed)
print("removed", report.removed)
print("unchanged", report.unchanged)
```

`sync` takes the same paths as `run` and names documents the same way. It keeps a file
called `manifest.json` under the pipeline's `path`. For each document, the manifest
records its name, a hash of its bytes and the id of its pieces. It also records a hash
of the index settings and the id of the index.

Each sync compares the folder with the manifest:

- A new file is parsed, cleaned, chunked and added to the index.
- A changed file is parsed again. Its old pieces leave the index and its new ones go in.
- A removed file has its pieces taken out of the index.
- An unchanged file costs nothing. Every one of its steps is read from the cache.

A document is in `report.changed` when its bytes changed, or when its pieces came out
different because the settings changed. `report.config_changed` is true when the index
settings differ from the last sync. Then only the steps from the first changed setting
on run again, as in [The cache](#the-cache).

The index is built again on each sync rather than edited in place. That is cheap: the
steps of unchanged files are cache hits, and their vectors come from the embedding
cache. A sync of a folder where nothing changed only reads what is stored.

After a sync that worked, the manifest is written and the previous index is deleted, so
the pieces of a removed file are gone from the index. The report is also a full index
report, so `report.documents`, `report.index` and `report.ok` work as in
[Build an index](#build-an-index). If a step fails, the manifest and the previous index
are left as they were, and the next sync tries again.

A removed file's earlier steps stay in `artifacts/` and its bytes stay in `sources/`, so
putting it back costs nothing. To remove every copy, delete the pipeline's `path` folder
and sync again.

When to sync is up to you: by hand, from a scheduled job, or from a script that watches
the folder.

## Search an index

Once a pipeline has built its index, search it with a question:

```python
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
p.index.run("docs/")
result = p.retrieve("How big should a chunk be?", k=5)
for hit in result.hits:
    print(hit.rank, hit.score, hit.chunk.text)
```

The `retrieve` section of the file says what runs, in this order:

1. **rewrite**, optional. Left out or `none`, the question is searched as asked. With
   `use: llm_rewrite`, a chat model restates it first, as in
   [Rewrite a question](#rewrite-a-question).
2. **search**, required. One retriever: `dense` (by meaning), `bm25` (by words) or
   `hybrid_rrf` (both, fused). Its `top_k` is how many pieces it hands on.
3. **rerank**, optional. None, one step, or a list that runs in order. Each step
   reorders the pieces the step before it handed on:
   - `mmr` trades some relevance for variety. It needs no extra model.
   - `cross_encoder` reads the question and each piece together and scores the pair. It
     is slower and more accurate. Its model loads with the `models` settings, as the
     embedders do.
   - `llm_rerank` asks a chat model to put the pieces in order. It needs a key, and it
     makes one model call per question, so it is never cached.

Search wide and narrow late: a search `top_k` of 20 and a reranker `top_k` of 5 lets the
reranker choose.

`k`, when given, is how many hits the last step keeps: it sets that step's `top_k`. Left
out, the file's setting holds. The question is never written in the file; it is what you
pass to `retrieve`.

A model's key is never in the file either. Pass it to `retrieve` as `credentials`:

```python
result = p.retrieve(question, credentials={"anthropic_api_key": "sk-ant-..."})
```

The names are the same as for `pandion.rewrite`: `anthropic_api_key`,
`openai_api_key` and `openrouter_api_key`.

**Which index it searches.** `retrieve` searches the documents that the last
`p.index.run` or `p.index.sync` of this pipeline indexed. In a new process with no run
yet, it reads the manifest that the last sync wrote. With neither, it says to index some
files first. The search runs through the same cache as the index, so the index is read,
not built again.

**What each step did.** `retrieve` returns a `Retrieval`:

- `result.hits`, the hits, best first. Each has `rank`, `score` and `chunk`, and after a
  reranker also `prior_rank` and `prior_score`, which say where it stood before.
- `result.result`, the last step's whole `RetrievalResult`.
- `result.stages["rewrite"]`, `result.stages["search"]` and `result.stages["rerank"]`.
  The last is a list with one entry per reranker. Each is a `StageResult` with its
  `output`, `status`, `artifact_id`, `duration_ms` and `note`, as in
  [Build an index](#build-an-index). The search's output shows the pieces before any
  reranker moved them.
- `result.index`, the index step the search read.
- `result.ok`, which is false if any step failed. A step that fails is reported, not
  raised, and then `hits` is empty.

```python
result.stages["search"].output.hits     # the pieces before reranking
result.stages["rerank"][0].note         # what the first reranker did
```

Ask the same question again and every step is `cached`, except `llm_rewrite` and
`llm_rerank`, whose model answers can change.

To load the default cross-encoder before the first search, call
`pandion.preload_reranker()`. It takes a model name and `pandion.ModelSettings`, like
`preload_embedder`.

## Ask a question

`ask` runs the retrieval and then the answer step, in one go:

```python
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
p.index.run("docs/")
answer = p.ask("How big should a chunk be?")
print(answer.text)
```

The `answer` section of the file names the answer step. There are two:

- `search` shows the pieces that retrieval found, as they are, with their rank, score
  and pages. It needs no model and no key, so it costs nothing. Its `top_k` is how many
  pieces it shows.
- `chat` sends the pieces and the question to a chat model, which answers using only
  those pieces. Every claim in the answer points at the passage it relied on, and each
  citation is checked against the parsed document. It needs a key, and it is a new model
  call every time, so it is never cached.

```yaml
answer:
  use: chat
  model: claude-haiku-4-5   # any model rewrite can use; see Rewrite a question
  max_chunks: 5             # how many of the top pieces go to the model
```

A file with an `answer` section needs a `retrieve` section too, because the answer step
reads what retrieval found. Pass a model's key as `credentials`, with the same names as
for `retrieve`:

```python
answer = p.ask(question, credentials={"anthropic_api_key": "sk-ant-..."})
```

`k` works as for `retrieve`: it sets how many hits the last retrieval step keeps.

`ask` returns an `Answer`:

- `answer.text`, the chat answer as one text, or the pieces found one after another.
- `answer.output`, the answer step's whole output. Its `kind` is `search` or `chat`, and
  its `payload` holds the pieces, or the answer with its `citations` and counts.
- `answer.hits`, what retrieval found, best first.
- `answer.stages`, with `rewrite`, `search`, `rerank` and `answer`, each a `StageResult`
  as in [Search an index](#search-an-index).
- `answer.ok`, which is false if any step failed. A step that fails is reported, not
  raised, and then `output` is None.

With several documents in the index, `chat` finds its citations in the first document by
name, the same rule as for a rewrite. A citation from another document is kept, and
marked as not verified.

## Three ways to write a pipeline

A pipeline can be written as a YAML file, as a dict for each stage, or as classes in
code. All three give the same pipeline: the same settings give the same artifact ids and
the same results whichever way they are written, so they share one cache.

As a file, read with `Pipeline.from_yaml`:

```yaml
path: ./my-index
index:
  parse: {use: pdfium}
  clean: [{use: dedupe_blocks}]
  chunk: {use: recursive_character, chunk_size: 400, chunk_overlap: 40}
  embed: {use: qwen3-embedding-0.6b}
  store: {use: lancedb}
retrieve:
  search: {use: hybrid_rrf, top_k: 20}
  rerank: [{use: mmr, top_k: 5}]
answer: {use: search, top_k: 3}
```

As a dict for each stage. Each dict is that stage's block in the file:

```python
from pandion import Pipeline

p = Pipeline(
    path="./my-index",
    parse={"use": "pdfium"},
    clean=[{"use": "dedupe_blocks"}],
    chunk={"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 40},
    embed={"use": "qwen3-embedding-0.6b"},
    store={"use": "lancedb"},
    search={"use": "hybrid_rrf", "top_k": 20},
    rerank=[{"use": "mmr", "top_k": 5}],
    answer={"use": "search", "top_k": 3},
)
```

As classes, with no YAML at all:

```python
from pandion import Pipeline
from pandion.answer import Search
from pandion.chunk import RecursiveCharacter
from pandion.clean import DedupeBlocks
from pandion.parse import Pdfium
from pandion.rerank import Mmr
from pandion.retrieve import HybridRrf

p = Pipeline(
    path="./my-index",
    parse=Pdfium(),
    clean=[DedupeBlocks()],
    chunk=RecursiveCharacter(chunk_size=400, chunk_overlap=40),
    embed="qwen3-embedding-0.6b",
    store="lancedb",
    search=HybridRrf(top_k=20),
    rerank=[Mmr(top_k=5)],
    answer=Search(top_k=3),
)
```

Each class has the same settings, with the same names and checks, as the step's block in
the file. A plain name such as `"lancedb"` is short for `{"use": "lancedb"}` with the
default settings. The classes are in:

| Module | Classes |
|---|---|
| `pandion.parse` | `Pdfium`, `Docling` |
| `pandion.clean` | `HeaderFooterStrip`, `DedupeBlocks`, `DropMatching` |
| `pandion.chunk` | `RecursiveCharacter`, `LayoutBlocks`, `MarkdownHeader`, `TokenBased`, `SentenceWindow` |
| `pandion.rewrite` | `Text`, `LlmRewrite` |
| `pandion.retrieve` | `Dense`, `Bm25`, `HybridRrf` |
| `pandion.rerank` | `Mmr`, `CrossEncoder`, `LlmRerank` |
| `pandion.answer` | `Search`, `Chat` |

`embed` takes the embedder's name, or a dict with `truncate_dim`. `store` takes
`"lancedb"`, or a dict with `metric` and `build_fts`. `models` takes a dict or
`pandion.ModelSettings`.

`pandion.parse`, `pandion.clean`, `pandion.chunk` and `pandion.rewrite` still run one
stage when you call them, as in [Try one stage at a time](#try-one-stage-at-a-time).

**Mixing.** The ways can be mixed in one pipeline, for example
`clean=[DedupeBlocks(), {"use": "drop_matching", "pattern": "Draft"}]`.

**One part at a time.** Each part can be built on its own: `IndexPipeline` (parse,
clean, chunk, embed, store), `RetrievalPipeline` (rewrite, search, rerank) and
`QueryPipeline` (the answer step). Each takes the part before it:

```python
from pandion import IndexPipeline, QueryPipeline, RetrievalPipeline

index = IndexPipeline(path="./my-index", parse=Pdfium(), chunk=RecursiveCharacter(),
                      embed="qwen3-embedding-0.6b", store="lancedb")
retrieval = RetrievalPipeline(index, search=HybridRrf(top_k=20), rerank=Mmr(top_k=5))
query = QueryPipeline(retrieval, answer=Search(top_k=3))
index.run("docs/")
print(query.ask("How big should a chunk be?").text)
```

Each part also has `from_yaml`, which reads its sections of a file.

**Back to a file.** `to_yaml()` writes any pipeline, or any part, as a file. Built from
that file, it is the same pipeline, so code can move to production unchanged:

```python
p.to_yaml("pipeline.yaml")      # also returns the text
```

**Mistakes fail early.** An unknown setting fails when the pipeline is built, in every
way, with a message that names the stage and lists its settings. A class says it as soon
as it is made: `Docling(do_ocrr=True)` raises
`index.parse (docling) has no setting 'do_ocrr'. Its settings are: do_ocr, ...`. A
missing stage, such as `chunk`, is an error that names it.

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

The local embedders (`qwen3-embedding-0.6b` and `bge-small-en-v1.5`) and the
`cross_encoder` reranker use a model from Hugging Face. `models.download` decides what happens when it is not on disk yet.

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

A step in the `retrieve` section is named the same way, for example
`retrieve.search (dense)` or `retrieve.rerank step 2 (cross_encoder)`, and the answer
step as `answer (chat)`. A pipeline written as dicts or classes gets the same messages.

The same checks apply to `pandion.parse`, `pandion.clean`, `pandion.chunk` and
`pandion.rewrite`, where the message starts with "The chunker", "Clean step 1" or "The
query step" instead of the place in the file. A
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
reused. A second script syncs a folder, adds a sample, syncs again, removes it, and
syncs once more. `rewrite_question.py` prints a question as typed and, with
`ANTHROPIC_API_KEY` set, as a model rewrites it. `search_samples.py` indexes two samples,
searches them, prints what each step did and the hits, then searches again to show
every step was reused. `ask_samples.py` asks the samples a question and prints the pieces
found, and with `ANTHROPIC_API_KEY` set, Claude's answer with citations.
`three_styles.py` builds the same pipeline as a file, as dicts and as classes, and prints
that the artifact ids match. A test runs all six, so they stay correct.
