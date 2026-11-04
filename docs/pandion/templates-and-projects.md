# Templates and projects

Three ways to write a pipeline, pipeline templates, and starting a project.

[Manual index](index.md) | Previous: [use-from-an-app](use-from-an-app.md) | Next: [conversations](conversations.md)

## Three ways to write a pipeline

A pipeline can be written as a YAML file, as a dict for each stage, or as classes in
code. All three give the same pipeline: the same settings give the same artifact ids and
the same results whichever way they are written, so they share one cache. The playground's Starter
pipeline is [`samples/starter.yaml`](../../samples/starter.yaml): a good first file to copy.
For a pipeline chosen for your documents and your questions, start from the
[templates](#templates): pick an index template, such as Reports with tables, and a
query template, such as Best precision, and `pandion.compose_template` joins them into
one pipeline dict for `Pipeline.from_dict`.

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
`"lancedb"` or any other index strategy's name, or a dict with `use` and its settings, such
as `metric` and `build_fts` for lancedb. `models` takes a dict or
`pandion.ModelSettings`.

`pandion.parse`, `pandion.clean`, `pandion.chunk` and `pandion.rewrite` still run one
stage when you call them, as in [Try one stage at a time](stages.md#try-one-stage-at-a-time).

An app that keeps pipelines as JSON can use the file's content as a dict, and get it back:

```python
p = Pipeline.from_dict(data, base="./")   # data is the file's content; relative paths are read from base
data = p.to_dict()                        # plain data, the file's shape
```

**Mixing.** The ways can be mixed in one pipeline, for example
`clean=[DedupeBlocks(), {"use": "drop_matching", "pattern": "Draft"}]`.

**One part at a time.** Each part can be built on its own: `IndexPipeline` (parse,
clean, chunk, enrich, embed, store), `RetrievalPipeline` (rewrite, search, rerank) and
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

## Templates

A template is a real starting point for a pipeline, chosen for a kind of document or a
kind of question. Pandion ships two families, `index` and `query`, and you pick one of each:

- An **index template** sets one category: how a kind of document is parsed, cleaned and cut
  into pieces. The embedder and the store are the same for every index template.
- A **query template** sets the retrieval side and the answer: how the question is
  rewritten, how the index is searched, how the hits are reranked, and what the answer
  step does.

`pandion.compose_template` joins one of each into a full pipeline, in the pipeline file's
shape, and `pandion.list_templates()` lists both families:

```python
import pandion

p = pandion.Pipeline.from_dict(pandion.compose_template("tables", "precision", path="./my-index"))
p.index.run("report.pdf")
print(p.ask("What was the revenue in 2024?").text)

for t in pandion.list_templates()["query"]:
    print(t["id"], t["name"], "needs a key" if t["needs_key"] else "")
```

Each template in the list has its `id`, `name`, `summary`, `good_for` and `pipeline` (the
part it sets: an index template's `category`, a query template's `retrieve` and `answer`).
An index template may also name the RAG Playground `sample` that suits it (`web` has none),
and a query template says whether it `needs_key`. The first run downloads the models a pair uses.

### Index templates

| Template | Id | Good for |
| --- | --- | --- |
| Text documents | `text` | Articles, policies and plain reports set in one column, with few tables |
| Reports with tables | `tables` | Financial reports, data sheets and studies whose answers sit in table rows |
| Scanned PDFs | `scanned` | Scanned paper, photographed pages and any PDF whose text cannot be selected |
| Manuals and guides | `manuals` | Manuals, handbooks, guides and specifications with numbered or clearly styled headings |
| Web pages | `web` | Articles, documentation pages and blog posts saved as HTML or fetched from a link |

- **Text documents** reads the PDF's text layer with pdfium, removes running headers,
  footers and repeated blocks, and cuts pieces of five sentences that share one sentence.
- **Reports with tables** reads the layout with Docling, rebuilds tables with the
  accurate table model, and cuts along the layout so a table stays whole with its caption.
- **Scanned PDFs** reads the page images with Docling's OCR, removes near repeats, and
  cuts along the layout.
- **Manuals and guides** reads heading levels with Docling's heading hierarchy, starts a
  new piece at each heading numbered down to three parts, such as 1.2.3, and searches each
  piece with its heading path. Docling puts the title and headings numbered like 1 at level
  2, so the template sets `section_level: 4`. Its sample, `station-manual`, has numbered
  headings four levels deep, and each piece holds one subsection such as 2.2.1, with a
  heading like 2.2.1.1 kept inside it.
- **Web pages** reads HTML with Docling, drops cookie banners, menu lines and footer lines,
  removes repeated blocks, and starts a new piece at each heading. It has no sample.

Every index template is one category, so it sets only `parse`, `clean` and `chunk`.
The embedder and the store are the same for all of them and live in
`pandion.pipeline_templates.SHARED_INDEX`: `qwen3-embedding-0.6b`, and lancedb with its
keyword index, which the hybrid search in every query template needs.
`list_templates()["shared"]` returns them as `{"index": {"embed": ..., "store": ...}}`.

`compose_template(index, query)` makes a pipeline with one category, named by the
index template's id, with `template` set to the same id, a single route rule that takes
every document, and the shared `index`:

```python
config = pandion.compose_template("tables", "balanced")
config["categories"]["tables"]["template"]  # "tables"
config["route"]                              # [{"category": "tables"}]
config["index"]["store"]["use"]              # "lancedb"
```

### Query templates

| Template | Id | Good for | Key |
| --- | --- | --- | --- |
| Balanced | `balanced` | Everyday questions, when you want good results quickly | No |
| Exact terms | `exact` | Questions that name a part number, a product, a person, a code or a clause | No |
| Best precision | `precision` | Single-fact questions, where the one right piece must come first and a slower search is fine | No |
| Vague questions | `vague` | Short or loosely worded questions that use different words from the document | Yes |
| Chat answer | `chat` | Questions you want answered in a sentence or two, with each claim pointing at its source | Yes |

- **Balanced** runs hybrid search (`hybrid_rrf`, 20 candidates), then the small MiniLM
  cross-encoder keeps the top five.
- **Exact terms** runs hybrid search (30 candidates) with `bm25_weight: 2`, so the keyword
  search counts twice as much as the meaning search, then the small, fast
  `cross-encoder/ms-marco-MiniLM-L-6-v2` cross-encoder. Best precision uses the stronger,
  slower reranker.
- **Best precision** runs hybrid search (30 candidates), then `BAAI/bge-reranker-v2-m3`,
  the strongest cross-encoder in the catalog. It is slower on a CPU, and it reads far
  more of a long piece. MiniLM reads only about the first 512 tokens of the question and a
  piece together, so with Balanced the end of a long piece, such as the lower rows of a
  big table, does not count.
- **Vague questions** asks Claude Haiku 4.5 to restate the question in the document's
  words and searches with that, then reranks like Best precision. The reranker scores
  the pieces against the question as typed, not the rewrite, so it can undo some of what
  the rewrite gained. It needs an Anthropic key.
- **Chat answer** is Best precision, then Claude Sonnet 5 answers from the top five pieces
  and cites them. It needs an Anthropic key.

### The template files

The files are in the package, under `pandion/templates/index/` and
`pandion/templates/query/`. Each is part of a pipeline file plus a `template:` block,
and most settings have a short comment that says why they were chosen. An index
template holds `category`; a query template holds `retrieve` and `answer`:

```yaml
template:
  name: Best precision
  summary: Hybrid search, then the strongest cross-encoder reads each candidate with the question. ...
  good_for: It suits single-fact questions, where the one right piece must come first and a slower search is fine.
retrieve:
  search: {use: hybrid_rrf, top_k: 30}
  rerank: [{use: cross_encoder, model: BAAI/bge-reranker-v2-m3, top_k: 5}]
answer: {use: search, top_k: 5}
```

RAG Playground serves the same list at `GET /api/templates`.
[`examples/pandion/run_template.py`](../../examples/pandion/run_template.py) runs a pair with
Pandion, and `examples/pandion-api/run_pipeline.py --template` runs one through
pandion-api. `tests/integration/test_template_parity.py` checks that every pair is valid
for Pandion and pandion-api. Its `models` test runs pairs that need no key through both
and checks they make the same pieces, the same hits in the same order and the same result
ids: three representative pairs on every Release check, and every such pair in the weekly
Template parity workflow (see CONTRIBUTING.md).

The playground's Starter (`samples/starter.yaml`) is Docling, `dedupe_blocks`, the
`recursive_character` chunker and hybrid search with no reranker. It is closest to
Reports with tables and Balanced, but it is not one of the pairs.

## Start a project

`pandion.new_project` writes a folder that runs a pipeline on your own documents, with
nothing else to set up. `pandion init` does the same from the command line.

```python
import pandion

config = pandion.compose_template("text", "balanced")
written = pandion.new_project("my-project", config, "questions.json")
```

It takes a `Pipeline` or a pipeline dict, an optional question set (a path, or a list or
dict, as `pandion.evaluate` takes), and returns the paths it wrote:

- `pipeline.yaml`: the pipeline. Its `path` and `models.cache_dir` are relative and use
  forward slashes, such as `./pandion-index`. A path that could lead out of the project
  (absolute, a drive, a URL, `~` or `..`) keeps only its last part, so no folder of the
  computer that wrote it ends up in the file. Every other setting is copied as it is.
  `models.public_endpoints_only` is left out, so the default applies at home.
- `run.py`: indexes the files in `docs/` that any category's parse step reads (`.pdf` for pdfium; every
  format in [Documents other than PDFs](stages.md#documents-other-than-pdfs) for docling), says which
  other files it skipped, then evaluates the questions in
  `questions.json`, or asks one example question when there is no question set. It
  stops with a sentence when a question names a document not in `docs/`, and prints the results
  and the cost of the run. Subfolders of `docs/` are not read.
- `questions.json`: only when you give a question set.
- `README.md`: how to set it up with Python 3.13 and run it, and the environment variable
  that holds the key when a step calls a model, such as `ANTHROPIC_API_KEY`. A key value
  is never written to any file. For a custom model, the README says the variable is
  needed only if the server asks for a key. When the questions name their documents, the
  README says that the files in `docs/` must match those names exactly, extension included.
- `requirements.txt`: `pandion[...]` with the extras the pipeline needs (`p.extras()`),
  pinned to this minor version, such as `~=0.7.0`, and a commented line that installs
  the much smaller CPU-only torch.
- `docs/`: an empty folder for your documents.

`readme_extra="..."` adds your own text at the end of the README. A folder that already
has files in it is refused with `FileExistsError`; `overwrite=True` writes the project
files into it and leaves your other files alone; without questions it also removes an old
`questions.json`. A pipeline that loads plugins is refused with a `ValueError`, because
plugin modules cannot be packed into a project, and so is a `custom_base_url` with a user
name or password in it.

From the command line, `pandion init` picks the two templates by number:

```bash
pandion init my-project
pandion init my-project --index text --query balanced --questions questions.json
```

Without `--index` and `--query`, it lists each family's templates with their summaries
and asks for a number. When nothing can be typed in, as in a script, it needs both flags
and says so. `--overwrite` writes into a folder that has files in it. Ctrl+C at the
prompt stops it with exit code 130.

### A project to serve

`kind="serve"` (`pandion init --serve`) writes a project for a server instead of a laptop:
a Docker image that answers `POST /chat` and `POST /ask` with
[pandion-api in serve mode](../pandion-api/serve-mode.md).

```python
written = pandion.new_project(
    "my-service", config, kind="serve",
    categories_questions={"manuals": {"questions": [...]}},
    source="./docs",            # a folder, or s3://, gs:// or az:// bucket path
    index_store="lancedb",      # or "qdrant", with index_url="https://..."
)
```

It writes `pipeline.yaml` (a `source:` block for `pandion sync`, `models: {download: never,
cache_dir: /models}` and a commented `access:` example), `pyproject.toml`, `.env.example`,
`README.md`, `serve.py`, `policy.py`, `Dockerfile`, `.dockerignore`, `.gitignore`,
`tests/test_quality.py` and, when you give questions, one `evals/questions.json` whose
questions are tagged `category:<name>`. The fixed files (`serve.py`, `policy.py`, `Dockerfile`,
the ignore files and the test) are the same for every project.

- When the pipeline uses a local model or Docling, `pyproject.toml` lists `torch` (and `torchvision` for Docling) as a direct dependency and takes it from the CPU-only index on Linux, so `uv lock` does not pull the multi-GB CUDA build. (uv applies a source only to direct dependencies, which is why torch is listed.) An address with a user name, a password or a query string is refused, because it would be written into the project.
- The Dockerfile pins its base image and `uv` by digest, installs from `uv.lock` (run `uv lock`
  once, then commit it), sets `HF_HOME=/models/hf`, runs `pandion models pull pipeline.yaml`
  at build time and starts one worker as a non-root user.
- `policy.py` reads the user from a header (`USER_ID_HEADER`, default `x-user-id`; a request
  without it gets 401). Its `roles` returns an empty list, with a comment to fill it in from
  your identity system. Until you do, a pipeline with an `access:` block shows nobody any
  document. It has no token checking: put the server behind a gateway that sets the header.
- A LanceDB index lives in the image's `index/` folder. For an index shared by several
  servers use `index_store="qdrant"` with `index_url`; the key is read from `QDRANT_API_KEY`.
  A remote LanceDB location is refused.
- No key, secret or absolute path of your computer is written to any file. `.env.example`
  lists names only.
- `tests/test_quality.py` fails until you record `evals/baseline.json`; it then runs
  `pandion eval` with the stale check first, so a changed document reads as a stale question
  set and not as a retrieval regression.

Fill the index with `pandion sync pipeline.yaml` before the server is ready: `GET /ready`
answers 503 until the index has data.
