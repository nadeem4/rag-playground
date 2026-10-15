# Pandion

Retrieval pipelines you can inspect, step by step.

Pandion parses your documents, cleans and chunks them, embeds and stores them, then
searches, reranks and answers questions. Every step is a strategy you can swap, and every
step tells you what it did. Each result is cached under a hash of its settings, so the
same files with the same settings are never processed twice.

Pandion is named after the osprey, which spots a fish under the water and dives to
retrieve it. It is the engine of [RAG Playground](https://rag.codewithnk.com), a web app
that shows every step of a pipeline on a PDF.

## Install

Pandion needs Python 3.13.

```bash
pip install "pandion[pdfium,lancedb,local]"
```

The base install is small. Parsers, stores and models are extras, and a step whose extra
is missing tells you which one to install:

| Extra | What it brings | Needed by |
|---|---|---|
| `pdfium` | pypdfium2 | the fast `pdfium` parser |
| `docling` | Docling and its OCR engine | the `docling` parser, for layout, tables and scans |
| `lancedb` | LanceDB and pyarrow | the index, and the `dense`, `bm25` and `hybrid_rrf` search |
| `local` | sentence-transformers and torch | the local embedders, and the `mmr` and `cross_encoder` rerankers |
| `anthropic` | the Anthropic SDK | `llm_rewrite`, `llm_rerank` and `chat` with Claude |
| `openai` | the OpenAI SDK | the same steps with OpenAI, OpenRouter or a compatible server |

`pandion install pipeline.yaml` installs the extras a pipeline file needs.

## Quick start

```python
from pandion import Pipeline

p = Pipeline(
    path="./my-index",
    parse="pdfium",
    chunk={"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 40},
    embed="bge-small-en-v1.5",
    store="lancedb",
    search="hybrid_rrf",
    answer="search",
)
p.index.run("report.pdf")
print(p.ask("What does the report recommend?").text)
```

The embedder downloads once, on first use. After that, a second `p.index.run` on the
same file finds every step already stored and reuses it.

## What you can do

- **Run one step on its own**, with no pipeline and no cache:
  `pandion.parse(pdf, use="pdfium")`, `pandion.clean(...)`, `pandion.chunk(...)`.
- **Write a pipeline three ways**: as a YAML file (`Pipeline.from_file("pipeline.yaml")`),
  as a dict per step, or with classes such as `from pandion.parse import Docling`. The
  three give the same pipeline and the same cache.
- **Build and update an index**: `p.index.run(files)` indexes them, and
  `p.index.sync(folder)` adds, changes and removes files to match a folder.
- **Search**: `p.retrieve(question)` runs the rewrite, search and rerank steps and returns
  each step's result as well as the hits.
- **Ask**: `p.ask(question)` returns the pieces found, or an answer from a chat model
  that cites them.
- **Evaluate and compare**: `pandion.evaluate(p, "questions.json")` scores a pipeline on
  a question set and says where each miss was lost, and `pandion.compare` runs one stage
  with several settings and names the best.
- **Start from a template**: `pandion.compose_template("tables", "precision")` joins an
  index template (how a kind of document is indexed) and a query template (how a
  kind of question is searched and answered) into a pipeline, and
  `pandion.list_templates()` lists them. See
  [Templates](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#templates).
- **Write your own strategy** for any stage, register it with `@register` from
  `pandion.extend`, and use it by name, from code, from `plugins:` in a pipeline file, or
  with `--plugins` on the command line.
  [The worked example](https://github.com/nadeem4/rag-playground/tree/main/examples/pandion/own_strategies)
  writes one for every stage.

## Start a project

`pandion init my-project` asks which index and query template to use, then writes a
folder you can run straight away: `pipeline.yaml`, `run.py`, `requirements.txt`, a
README and an empty `docs/` for your documents. In code, `pandion.new_project(folder, pipeline)`
writes the same folder for any pipeline. See
[Start a project](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#start-a-project).

## Use Pandion from the command line

`pandion validate pipeline.yaml`, `pandion index pipeline.yaml report.pdf`, `pandion ask pipeline.yaml "..."`:
the same pipeline, from the command line. See
[the pandion command](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#the-pandion-command).

## Learn more

- [The guide](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md): every
  step, setting and error.
- [Examples](https://github.com/nadeem4/rag-playground/tree/main/examples/pandion): index,
  sync, search, ask, the three ways to write a pipeline, and your own strategy for every
  stage.
- [RAG Playground](https://rag.codewithnk.com): try the same pipelines in the browser.

## License

MIT. See [LICENSE](https://github.com/nadeem4/rag-playground/blob/main/LICENSE).
