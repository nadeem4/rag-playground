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
| `qdrant` | qdrant-client | the `qdrant` index: Qdrant in a folder or on a server |
| `sql` | SQLAlchemy | the `sql` conversation store: SQLite, Postgres, MySQL or SQL Server |
| `local` | sentence-transformers and torch | the local embedders, and the `mmr` and `cross_encoder` rerankers |
| `anthropic` | the Anthropic SDK | `llm_rewrite`, `llm_rerank` and `chat` with Claude |
| `openai` | the OpenAI SDK | the same steps with OpenAI, OpenRouter or a compatible server |
| `files` | fsspec (plus gcsfs or s3fs for a bucket) | FilesSource, sync from a source |

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
- **Questions written for you**: `pandion.evaluation.write_questions(doc, model=...)`, or
  `pandion questions report.pdf --model ...`, has a chat model write a checked question set.
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

`pandion validate pipeline.yaml`, `pandion index pipeline.yaml report.pdf`, `pandion ask pipeline.yaml "..."`,
`pandion forget-user alice --url-env VAR --yes` (deletes one user's conversations and memories from a conversation store), and `pandion sync pipeline.yaml` (reads the `source:` block of the file, needs `pandion[files]`
for the `files` source, prints one JSON summary line and exits non-zero when a document was
left out): the same pipeline, from the command line. `pandion eval pipeline.yaml questions.json
--record-baseline base.json` saves a baseline with the platform and models it was made with, and
`--baseline base.json` then fails when any category newly misses a question (asked once more
first when a step can differ between runs). Before it searches, `pandion eval` exits 1 on a
question whose expected passage is no longer in the parsed documents. `--judge` (off by default,
costs model calls) also grades each answer against the question's expected `answer`, and
`--judge-gate` fails a baseline comparison when the mean correctness fell more than 0.05. A question with a `history` (a follow-up) is rewritten first with `claude-haiku-4-5`, which needs `ANTHROPIC_API_KEY`; without it the question is searched as written and counted in `rewrites_failed`. Follow-ups are their own gated category, `follow-up`. See
[the pandion command](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#the-pandion-command).

## Chat turns

`pandion.chat_turn.chat_turn(p, store, user_id=..., question=...)` answers one turn of a
conversation kept in a conversation store (`pandion[sql]`). A follow-up is first rewritten
into a question that stands alone, using the running summary and the last turns, and the
answer step is asked only that question, so history gives meaning and only the sources give
facts. `fold_summary` folds older turns into the summary; run it after replying. With
`ChatSettings(memory=True)` (off by default), `remember` keeps a user's short facts and they
help the rewrite only, never the answer. All are
Provisional. See [A chat turn](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#a-chat-turn)
and [`chat_turn.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/chat_turn.py).

Answers are made safer by default: sources are fenced in the prompt as untrusted data, and
`chat_turn` removes links and images from a reply unless a source holds the same address
(`ChatSettings(strip_urls=False)` turns that off). See
[Answer safety](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md#answer-safety).

## Extend Pandion

These are the extension points and how steady each one is. Pandion is 0.x, and a Stable
contract changes only after a deprecation in the changelog. Each recipe below is taken
from an example that the repository's tests run.

| Extension point | Level | Tested example |
| --- | --- | --- |
| Source | Stable | [`zip_source.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/extensions/zip_source.py) |
| Route check | Stable | [`route.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/own_strategies/my_strategies/route.py) |
| Access rule | Stable | [`owner_access.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/extensions/owner_access.py) |
| Index store | Stable | [`json_file_store.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/extensions/json_file_store.py) |
| Conversation store | Stable | [`dict_conversation_store.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion/extensions/dict_conversation_store.py) |
| Policy | Stable | [`policy_example.py`](https://github.com/nadeem4/rag-playground/blob/main/examples/pandion-api/policy_example.py) |
| Step plugins, executor events, online evaluators | Provisional | |

Import the module before you build the pipeline (or list it under `plugins:` in the
pipeline file), so its name is registered.

**A source** lists documents and reads one on request. `index.sync(source)` reads only
what is new or changed, so give each entry a version that changes when its content does.
The example is registered as `zip`:

```python
import zip_source  # registers "zip"
from pandion.document_sources import get_source

report = pipeline.index.sync(get_source("zip", location="docs.zip"))
```

In the pipeline file, `source: {use: zip, location: docs.zip}` and `pandion sync` do the same.

**A route check** looks at a `DocumentInfo` and returns True or False. The example is
`is_invoice`. Register it with
`@route_check("is_invoice", ...)` and use it as `when: {use: is_invoice}`.

**An access rule** takes a `DocumentInfo` and returns role names, or None for no
opinion. The example, `team_from_path`, gives `legal/a.pdf` the role `legal`. Use it as
`access: {rules: [team_from_path]}`. A rule that fails leaves the document visible to nobody.

**An index store** keeps the rows of an index. Apply the filter before you rank; a row with empty
roles never matches a roles filter. The example is registered as `json_file`, proven with
`pandion.testing.store_conformance`, and used from code:

```python
from pandion.index_store import get_store

store = get_store("json_file", {"folder": "my-index"})
```

A registered store reaches `pipeline.yaml` only through an index step, because
`StoreIndex` is not a Stable export.

**A Policy** (in pandion-api) is its one place for a site's rules. See
[the pandion-api README](https://github.com/nadeem4/rag-playground/blob/main/packages/pandion-api/README.md#the-policy).

## Learn more

- [The guide](https://github.com/nadeem4/rag-playground/blob/main/docs/pandion.md): every
  step, setting and error.
- [Examples](https://github.com/nadeem4/rag-playground/tree/main/examples/pandion): index,
  sync, search, ask, the three ways to write a pipeline, your own strategy for every
  stage, and a source, access rule and index store of your own.
- [RAG Playground](https://rag.codewithnk.com): try the same pipelines in the browser.

## License

MIT. See [LICENSE](https://github.com/nadeem4/rag-playground/blob/main/LICENSE).
