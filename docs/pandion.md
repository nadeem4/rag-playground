# The pandion package

Pandion is the engine of RAG Playground as a Python package. The
playground runs on it. Every stage can be run and inspected on its own, and a whole
index can be built from one config file. Each step's result is cached under a hash of its
recipe, so the same files with the same settings are never processed twice.

This guide covers what exists today: parse, clean, chunk, the index, keeping an index up
to date, the rewrite of a question, searching an index with rerankers, asking a question,
evaluating a pipeline on a question set, comparing settings at one stage, and three ways to write the same pipeline: a YAML file, a dict per stage, and classes in
code.

Before each release to PyPI, [checks/pandion-install/](../checks/pandion-install)
installs the built package in new environments, with and without extras, and tests it there.

## Contents

- [Install](#install)
- [Try one stage at a time](#try-one-stage-at-a-time)
- [Documents other than PDFs](#documents-other-than-pdfs)
- [A URL as a document](#a-url-as-a-document)
- [Rewrite a question](#rewrite-a-question)
- [The pipeline file](#the-pipeline-file)
- [Build an index](#build-an-index)
- [Keep an index up to date](#keep-an-index-up-to-date)
- [Search an index](#search-an-index)
- [Ask a question](#ask-a-question)
- [Evaluate a pipeline](#evaluate-a-pipeline)
- [Questions written for you](#questions-written-for-you)
- [Compare settings](#compare-settings)
- [Speed and cost](#speed-and-cost)
- [Running a pipeline from an app](#running-a-pipeline-from-an-app)
- [Three ways to write a pipeline](#three-ways-to-write-a-pipeline)
- [Templates](#templates)
- [Start a project](#start-a-project)
- [The cache](#the-cache)
- [Models](#models)
- [Install what a file needs](#install-what-a-file-needs)
- [The pandion command](#the-pandion-command)
- [Index stores](#index-stores)
- [Write your own strategy](#write-your-own-strategy)
- [Loading your strategies](#loading-your-strategies)
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
| `anthropic` | the Anthropic SDK | `llm_context`, `llm_rewrite`, `llm_rerank` and `chat` with a Claude model |
| `openai` | the OpenAI SDK | `llm_context`, `llm_rewrite`, `llm_rerank` and `chat` with an OpenAI model, OpenRouter or a custom endpoint |

The cleaners, the chunkers, the `text` query step and the `search` answer step need only the base install. The `fake-deterministic`
embedder needs no extra and no download, so it is good for trying things out.

Inside the repo, `uv sync --extra dev` installs the package with the extras the app
uses, and `uv run` then finds it.

## Try one stage at a time

These calls run one strategy directly. They use no pipeline and keep no cache. Each one
returns a `StageResult` with `.output`, `.note` (one sentence about what the stage did),
`.duration_ms` and `.usage` (the tokens a step that calls a model recorded, or None).
For `pandion.clean`, `.usage` is that of the last cleaner that recorded one.

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
print(pandion.chunk.stats(chunks.output))  # pieces, sizes, overlaps, text left out
```

`pandion.chunk.stats(chunk_set)` sums up a chunk set as an app shows it: `pieces` and
`tokens`; `median`, `p95` and `largest`, each piece's size in `unit`, the unit the
chunker's size setting counts in (`characters` for `recursive_character`, `tokens` for
the rest); `median_tokens` and `p95_tokens`; `overlaps`, pairs of pieces that share text;
and `uncovered`, characters of the text no piece covers. `pandion.chunk.stats(a, b, ...)` sums up one
chunker's chunk sets for several documents as one: counts, overlaps and `uncovered` are
totals, and the sizes are over every piece of every set.

The sample PDFs live in `samples/`, one folder each: `chunking-primer`,
`two-column-report`, `table-of-figures`, `scanned-notes` and `station-manual`.

A strategy's settings are keyword arguments, with the same names as in the app's
settings forms. `clean` takes a list of steps and runs them in the order given. Each step
names its cleaner with `use` and holds its settings beside it, for example
`{"use": "drop_matching", "pattern": "Draft"}`. Its note has one line per step, saying
what it removed. `clean` and `chunk` accept either a parsed document or the result of
the stage before, as above.

## Documents other than PDFs

Each parser reads a fixed set of formats, chosen by the file's extension:

| Format | Extensions | `pdfium` | `docling` |
|---|---|---|---|
| PDF | `.pdf` | yes | yes |
| Word | `.docx` | no | yes |
| PowerPoint | `.pptx` | no | yes |
| HTML | `.html`, `.htm` | no | yes |
| Markdown | `.md` | no | yes |
| Plain text | `.txt` | no | yes |
| PNG and JPG images | `.png`, `.jpg`, `.jpeg` | no | yes |

```python
parsed = pandion.parse("notes.docx", use="docling")
```

A parser declares its formats in `provides`, for example `{"formats": ["pdf"]}` for
`pdfium`. A pipeline checks every file against its parser before any step runs, so a file
the parser cannot read fails at once with a plain message, such as `pdfium reads PDF files;
notes.docx is a Word file. Use docling.` The extension is matched without regard to case.
A file with no extension, and a parser that declares no formats, are not checked. The
error is `pandion.extend.UnreadableFormat`, a `ValueError`, so a server can catch it alone.

An index run also reads the first 8 KB of each Word, PowerPoint, HTML, Markdown and text
file before any step runs. Docling picks its reader by the bytes before the name, so a PDF
or an image renamed `.md` would run its layout or OCR models. Such a file fails with the
same error: `this file is named .md but holds a PDF`. A stored file that is gone is not
read, so an index whose steps are all cached still runs without it. A server can make the same check
itself with `pandion.extend.check_contents(path, filename)`.

Word, HTML, Markdown and text files load no model, so Docling reads them quickly.
Docling reads a `.txt` file with its Markdown reader, so a line that starts with
`#` becomes a heading. Headings keep their levels: in HTML and Markdown, `h1` or `#` is
level 1 and each level below is one deeper. In a Word file, Heading 1 is level 2, one below
the Title style; the levels still nest. An HTML `<title>` is read
as the first heading, unless the page's first heading says the same thing.

An image is a one-page document read with OCR. OCR is always on for images, whatever
`do_ocr` says; `do_ocr` is for PDFs only. Expect about 10 seconds a page, and a first run
that loads the OCR models.

**Documents without pages.** Word, HTML, Markdown and text files have no pages. Their
`page_count` is 0, every element's `page` and `bbox` are None, and every piece's
`page_span` is None. Chunking, search, answers and evaluation all work the same; a
citation just has no page. A PowerPoint file has one page per slide, so `page` is the
slide number. Its boxes, and an image's, are in that page's own units (slide units or
pixels), not PDF points.

## A URL as a document

A web address works wherever a file does, in `index.run`, `index.sync` and the
`documents` of `retrieve` and `ask`. It can sit beside local files in one list. In
`documents=[url]` on `retrieve` and `ask`, the page is fetched again on each call, so
each question costs one request to that site; the steps after it are still cache hits
when the bytes did not change.

A GitHub file link, `https://github.com/<owner>/<repo>/blob/<ref>/<path>`, is fetched as
the raw file from `raw.githubusercontent.com`, so the file is indexed and not GitHub's web
page. The query string is dropped. Raw GitHub answers `text/plain`, so the file is stored as
`.txt`. With `public_only`, the check runs on the raw address. Other GitHub links (a repo
page, `tree/`, `issues/`) are fetched as they are.

```python
p.index.run(["docs/", "https://example.com/guides/ferns", "https://example.com/report.pdf"])
p.index.run({"ferns.html": "https://example.com/guides/ferns"})   # name it yourself
```

**What is fetched.** Pandion sends one GET request for the address and follows up to 3
redirects. It reads the page's bytes and keeps them in `sources/` like an uploaded file,
then indexes them as one. The document id is the URL, unless a mapping names it. The file
name comes from the host and the path, joined with `-` and cut to 100 characters, with a
suffix that follows the content type the server sent: `example.com-report.pdf`,
`example.com-guides-ferns.html`, or `example.com.html` for a site's front page. So two
sites' front pages never share a name, and the
parser check in [Documents other than PDFs](#documents-other-than-pdfs) reads it right:
pdfium takes a PDF at a URL, and a web page needs docling.

Only these content types are accepted: HTML, PDF, Word (`.docx`), plain text, PNG and
JPG. Pandion does not follow links on the page, does not read sitemaps, and does not read
robots.txt, because one fetch a person asks for is not crawling. Every request carries an
honest User-Agent, `Pandion/<version>`, with a link to the project.

**The limits.** A fetch gives up 10 seconds after it starts. That is one deadline for the
whole fetch, redirects, headers and body included, so a server that sends one byte at a
time cannot hold it open. A page larger than 20 MB is refused:
Pandion stops reading one byte past the limit. A refusal stops the run before any step
runs, with a `pandion.extend.FetchRefused`, a `ValueError`. Its message is one plain
sentence and never repeats the address, so nothing secret in a query string reaches a
log:

```text
That address is not on the public internet, so it was not fetched.
Only https addresses on port 443 are fetched here.
The page is larger than the limit of 20,971,520 bytes, so it was not fetched.
Pandion reads HTML, PDF, Word, text, PNG and JPG files from a URL; this URL sent another kind of file, so it was not fetched.
The URL redirected more than 3 times, so it was not fetched.
The URL took longer than 10 seconds to answer, so it was not fetched.
The URL answered with status 404, so it was not fetched.
```

Each refusal also has a `kind`, so a server can choose its answer without reading the
message:

| `kind` | When |
|---|---|
| `bad_url` | the address is not `http://` or `https://`, or its host name is not valid |
| `not_https` | with `public_endpoints_only`: not https on port 443 |
| `not_public` | with `public_endpoints_only`: an address that is not on the public internet |
| `too_big` | the page is larger than the limit |
| `wrong_type` | the page sent a content type Pandion does not read |
| `too_many_redirects` | more than 3 redirects |
| `timed_out` | the fetch took longer than 10 seconds |
| `failed` | the page answered with an error status, or could not be reached |

**The guard.** On your own machine any address works, including a page on localhost or
your own network. On a server that strangers share, turn on
`models.public_endpoints_only` (the same switch that guards custom model endpoints, see
[Models](#models)):

```yaml
models:
  public_endpoints_only: true
```

Then every address, the first one and each redirect, must be https on port 443, and its
host must have only public addresses: not localhost, not a private or link-local range,
not a cloud metadata address. A name with one public and one private address is refused.
Pandion connects only to the addresses it checked, trying each in turn, and never looks
the name up a second time, so a name whose answer changes between the check and the
request (DNS rebinding) cannot reach a private address. TLS is still checked against the
host name. A redirect to a private address, or to plain http, is refused like the first
address would be. An `@` is allowed after the host, in the path or query, but never before
it, where it would carry a user name. A host name that has no ASCII (IDNA) form is
refused with `The URL's host name is not valid, so it was not fetched.`

**Sync with URLs.** `index.sync` fetches every URL again. When the page's bytes changed,
the document is in `report.changed` and its pieces are rebuilt; when they did not, it is
in `report.unchanged` and every step is read from the cache. A page that changes on every
visit, such as one that prints the time, shows as changed on every sync. The manifest
keeps the file name a fetched page was given, so a new process can search it.

To fetch a page yourself, for example in a server that checks the bytes before it
indexes them, call `pandion.extend.fetch_url(url, public_only=..., max_bytes=...)`. It
returns the bytes and the file name. To judge a file before you keep it,
`pandion.extend.format_of(filename)` gives its format by its extension (`"pdf"`, `"docx"`,
and so on), or None, and `pandion.extend.FORMATS` gives each format's name, what one file
of it is, and its extensions.

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

If you serve pandion to people you do not trust, set `public_endpoints_only: true` under
`models` in the pipeline (or `pandion.ModelSettings(public_endpoints_only=True)` in code).
A custom endpoint must then be a public https address, so a stranger cannot point the
server at its own network. The playground's hosted demo does this, through pandion-api's
Policy. `pandion.rewrite` is for trying a step yourself and leaves it off.

## The pipeline file

A pipeline file says how to build an index, how to search it and how to answer. This is
the full format, with every field the package reads.

```yaml
# pipeline.yaml

# Optional. The format version of this file. Leave it out or write 1. A file with a
# higher number is refused with a sentence that says to upgrade pandion.
version: 1

# Optional. Modules to import before the steps are checked, so strategies
# you wrote can be used by name. See Loading your strategies.
plugins: [my_company.rag_steps]

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
  public_endpoints_only: false   # true on a server strangers share: a custom endpoint must be a public https address

index:
  # source:             # optional; upload (the files given to index.run) when left out.
  #   use: my_source    # see Your own source
  parse:                # required
    use: pdfium         # pdfium or docling
  clean:                # optional; a list, run in order
    - use: dedupe_blocks   # also header_footer_strip, drop_matching
  chunk:                # required
    use: recursive_character
    chunk_size: 400     # any other key is a setting of this chunker
  enrich: none          # optional; none, or llm_context (see Context before embedding)
  embed:                # required when the store has an embedder setting, as lancedb does
    use: qwen3-embedding-0.6b   # or bge-small-en-v1.5, fake-deterministic
    truncate_dim: null  # optional
  store:                # required
    use: lancedb        # or any registered index strategy
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
`pandion.chunk.count_tokens(text)` counts tokens the way `token_based` does.

`store` takes any registered index strategy, built in or your own. `embed` and `store` are
one step when it runs, because the index embeds the pieces as it writes them. The rule for
`embed` fits in one sentence: if the store has an `embedder` setting, `embed` is required
and its `use` becomes that setting, and if it does not, the store embeds by itself and
`embed` must be left out.

### Categories and routes

Some documents need different steps: a scanned PDF needs OCR, a report with tables needs
table parsing. Name each kind of document a category, and say which documents go where
with a route. A file with `categories` and `route` replaces `index.parse`, `index.clean`
and `index.chunk`, which move under each category:

```yaml
categories:
  reports:
    name: Reports with tables      # optional, shown to people
    parse: {use: docling, table_mode: accurate}
    chunk: {use: layout_blocks, max_tokens: 400}
  text:
    parse: {use: pdfium}
    clean: [{use: dedupe_blocks}]
    chunk: {use: recursive_character, chunk_size: 400}

route:                  # first rule that matches wins; the last has no `when`
  - when: {use: file_type, types: [pdf]}
    category: reports
  - category: text

index:                  # shared by every category
  embed: {use: qwen3-embedding-0.6b}
  store: {use: lancedb}
```

Every category shares one `embed` and one `store`, so `embed`, `store`, `source` and
`enrich` stay under `index`. A file with both `categories` and `index.parse` is refused,
and so is a route whose last rule has a `when`. A category id may use only lowercase
letters, digits, underscore and dash, and any other is a `ConfigError` that names it.

A file without `categories` still works. Pandion reads its `index.parse`, `clean` and
`chunk` as one category named `default`, and writes it back the same way, so its
artifact ids, recipe hash and graph do not change.

Each document goes to the category the route chooses (see "Route documents to
categories" below), unless you choose its category by hand: `p.index.assign(categories={"a.pdf": "reports"})`, or
`p.index.run(paths, categories={...})` for one call. `p.index.assign(links={"a.pdf": "https://..."})` tells it which link a stored document came from. The route's `path` check reads that link. An unknown category name is a
`ValueError` that lists the real ones. `p.index.category_of("a.pdf")` says which category
a document has, and `report.documents["a.pdf"].category` says which one it went through.
In code, `Pipeline(path=..., categories={...}, route=[...], embed=..., store=...)` takes
the same blocks in place of `parse`, `clean` and `chunk`.

### What a route can look at

A route will choose a category from the cheap facts about a file, known before any
parsing. `pandion.extend.document_info(file, filename=..., doc_id=..., metadata=..., link=...)`
returns a `DocumentInfo` with these fields. `link` is the address the file was fetched from, and `path` reads it.

- `filename`, `type` (`pdf`, `docx`, `pptx`, `html`, `md`, `txt`, `png`, `jpg`, or `None`)
  and `size` in bytes.
- `path`: the folder path the file was added from, or its link. It is empty for a bare
  upload.
- `metadata`: a copy of the metadata you gave.
- `page_count`: pages of a PDF, or slides of a PowerPoint file. Otherwise `None`.
- `text_layer`: for a PDF, `True` when one of the first three pages has text and `False`
  when none has. `None` for other formats, or when pypdfium2 is not installed.
- `first_page_text`: the first PDF page's text, or the start of a Markdown or text file,
  at most 4,000 characters. Empty for other formats.
- `properties`: what is stored inside the file. Matching ignores case. The keys are:

| Format | Property keys |
| --- | --- |
| PDF | `Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer` |
| Word, PowerPoint | `Title`, `Author`, `Subject`, `Keywords`, `Category` |
| HTML | `Title` from `<title>`, and every `<meta name=...>` or `<meta property=...>` under its own name, read from the first 64 KB |
| JPG, PNG | EXIF tags by name, such as `Make`, when Pillow is installed |
| Markdown, text | none |

Reading never fails. A corrupt or encrypted file, a Word file with no core properties, or
a PDF with no pypdfium2 installed gives empty facts for what could not be read.

### Route documents to categories

`route` is a list of rules. Pandion tries them in order, and the first rule that matches
gives the document its category. A rule has a `category` and, except the last, a `when`.
`when` is one check, or a list of checks that must all be true. The last rule has no
`when`, so it takes every document no other rule took.

```yaml
route:
  - when: {use: path, pattern: "legal/**"}
    category: legal
  - when:
      - {use: file_type, types: [pdf]}
      - {use: text_layer, has: false}
    category: scans
  - category: text
```

A pipeline run passes no metadata yet, so `metadata` is always false there. Metadata
comes with adding or moving documents, in a later version. A source other than `upload`
has no file to read, so for its documents `text_layer`, `contains` and `properties` are
always false; `file_type`, `name` and `path` still work from the location.

Text matching ignores case. A missing key, a missing property, or a check that does not
apply to the file's type (`text_layer` on a Word file) is false, never an error. A check
that raises an error is false too, and the error goes in the reason. In `name` and `path`
patterns, `*` matches any text, including `/`, so `legal/**` and `legal/*` both match
`legal/a/b.pdf`. A metadata or property key also matches ignoring case.

| Check | True when | Settings |
| --- | --- | --- |
| `file_type` | the file's type is in the list | `types`: a list such as `[pdf, docx]` |
| `name` | the file name matches the pattern | `pattern` |
| `path` | the path the file was added from matches the pattern | `pattern` |
| `metadata` | a label given when the document was added is present and matches | `key`, and one of `equals`, `contains`, `pattern` |
| `properties` | a property stored inside the file is present and matches | `key`, and one of `equals`, `contains`, `pattern` |
| `text_layer` | a PDF has selectable text (`has: true`) or none (`has: false`) | `has` |
| `contains` | any of the words is in the first page's text | `words`: a list |

`metadata` and `properties` refuse zero or more than one of `equals`, `contains` and
`pattern`. A check you misspell, or a setting a check does not have, is a `ConfigError`
when the file is read, with `step` set to the check's place, such as `route.1.when.2`.

Every document gets a reason, in `report.documents["a.pdf"].reason`:

- `Rule 2: path matches legal/**`: the first matching rule, with each check's phrase
  joined by "and", such as `Rule 1: type is pdf and has no text layer`.
- `Default: no rule matched`: the last rule took it. If a check raised an error, the
  reason adds it, as in `Default: no rule matched; is_invoice failed: ValueError: boom`.
- `Chosen when added`: you chose the category by hand.

`pandion.catalog()["route"]` lists the checks with their settings as a JSON schema, in
the same shape as the strategies, so an app can draw their forms. `pandion.built_in_checks()`
returns the names of the ones Pandion ships, so a site that does not run plugins can tell
them from a plugin's.

### Write your own check

A check is a function of a `DocumentInfo` and its settings that returns `True` or `False`.
Register it with `@route_check`, and its name works in `when: {use: <name>}`:

```python
from pydantic import BaseModel
from pandion.extend import DocumentInfo, route_check

class IsInvoice(BaseModel):
    prefix: str = "INV"

@route_check("is_invoice", summary="The file name starts with a prefix.", config=IsInvoice)
def is_invoice(info: DocumentInfo, settings: IsInvoice) -> bool:
    return info.filename.startswith(settings.prefix)
```

Load it with `plugins: [my_rules]` in the pipeline file, like a strategy. A name that is
already taken is refused. A registered check is listed by `pandion.catalog()["route"]` and by
`GET /strategies` under `stages.route`, with its settings as a JSON schema, so an editor can offer it. Checks are not steps of the graph, so they have no cache and
no `apply()`. A server that runs other people's requests does not accept `plugins`.
[`examples/pandion/own_strategies/`](../examples/pandion/own_strategies) has this check.

### Context before embedding

A piece cut out of a document often does not say what it is about. There are two ways to
put context in front of each piece before it is embedded. Both change only what the piece
is searched by: its id, its text, its citation, the gold checks and the miss trace stay
the same.

- **Headings, free.** `heading_context: true` on the chunker puts the heading path above
  each piece in front of it. `recursive_character` and `layout_blocks` have it on by
  default; `token_based` and `sentence_window` have it off.
- **A model's context, paid.** `enrich: {use: llm_context}` asks a chat model to write one
  short sentence that places each piece in its document. It goes in front of the heading
  path, so the two add up.

```yaml
index:
  parse: {use: docling}
  chunk: {use: recursive_character, chunk_size: 400}
  enrich:
    use: llm_context
    model: claude-haiku-4-5
  embed: {use: qwen3-embedding-0.6b}
  store: {use: lancedb}
```

In code, pass `enrich={"use": "llm_context"}` to `Pipeline` or `IndexPipeline`, and the
key with `credentials=` to `index.run` or `index.sync`, as for the chat step. The
`pandion index` command reads the key from the environment. The report has an `enrich` step for each
document after `chunk`.

Keyword search (BM25) sees the context too, because the index keeps what was embedded in
its text column. That matches the published contextual retrieval recipe.

The cost is one model call per piece. Each call sends the document, up to its first
40,000 characters, as the same opening text marked for the provider's prompt cache, so
after the first call most of the input is a cache read. A short document is below the
provider's caching minimum (4,096 tokens for Claude Haiku 4.5), so each call then pays
full input, which is still small. The first call runs alone to fill the cache, and the rest run six at a time. A 20-page document cut into 50 pieces is
about 50 calls of some 10,000 input tokens each, mostly cache reads, plus 50 short
replies. `cost()` counts every input token and prices the cache reads at a tenth of the
input price (`pandion.llm.CACHE_READ_SHARE`).

The contexts are stored like any other result, so the same pieces again cost nothing.
Changing anything that makes new pieces, such as the parser, a cleaner or the chunk size,
pays again in full. A document with more pieces than `max_pieces` (200) is refused before
any call, and if one call fails the step fails and names the piece. See
[Strategies](strategies.md#enrich) for every setting and the built-in prompt.

## Build an index

```python
from pandion import Pipeline

report = Pipeline.from_yaml("pipeline.yaml").index.run("docs/")
```

`from_file` reads and checks the file; nothing runs yet. `run` takes a file, a folder or
a list of both. A folder gives every file under it except hidden ones. Each document is
named by its path inside the folder with forward slashes, such as `guides/chunking.pdf`.
A file given by itself is named by its file name.

To choose the names, pass a mapping: `p.index.run({"report.pdf": "/uploads/0f3a.pdf"})`
indexes that file as `report.pdf`. The same bytes under the same name give the same
results wherever the file is kept.

The report holds:

- `report.documents`, a dict from document name to a `DocumentReport`. Its `.stages`
  has one `StageResult` for each step, under the names `source`, `parse`, `clean.1`
  (then `clean.2` and so on), and `chunk`. Its `.category` is the category the document
  went through (`default` for a file without categories).
- `report.index`, the `StageResult` of the index. Its `.output` is the index folder.
- `report.ok`, which is false if any step failed or was skipped.

```python
report.documents["guides/chunking.pdf"].stages["chunk"].output   # the pieces
report.documents["guides/chunking.pdf"].stages["clean.1"].note   # what the cleaner removed
report.index.output                                              # the index folder
```

Each `StageResult` also has `status` (`executed`, `cached`, `failed` or `skipped`), `artifact_id`
(the recipe hash it is stored under), `duration_ms`, `note`, `error` and `usage`. A step that
fails is reported, not raised, and the steps after it are skipped.

`usage` says how many tokens a model step used in this run, as
`{"input_tokens": ..., "output_tokens": ..., "model": ...}`, where `model` is the model id
the server says it answered with, or the id that was sent when the server does not say.
They can differ: OpenRouter's `openrouter/auto` sends the question on to another model. A
count the server did not send is None, never 0. The rewrite, rerank and answer steps that
call a chat model fill it. A step that fails after its model call keeps the usage it
recorded, because the call was still billed. It is None for a step that calls no model,
and for a cached step, because a cached step used no tokens this time.

### Add one document

```python
p = Pipeline.from_yaml("pipeline.yaml")
p.index.add("legal/contract.pdf", metadata={"cms_type": "contract"})
p.index.add("https://example.com/guide", category="reports")
print(p.index.sort("draft.pdf"))   # what category it would get, and why; runs nothing
```

`add` takes one file, one link, or a folder of files, and adds them to the documents in the
manifest. A file's id is its file name, or its path inside the folder; a link's id is the link. It goes to `category` if you give one (the reason is then
`Chosen when added`), and otherwise where the route sends it. `metadata` is the labels the
route's `metadata` check reads. The index is built again, but every other document is a
cache hit. Adding an id that is already indexed raises a `ValueError` that points to
`p.index.move`. `add`, `move`, `sort` and `p.documents()` work with the upload source
only, like `sync`. `sort` reads a file where it is and writes nothing. A link is fetched and kept in `sources/`. `sort` also takes a dict of `{document id: file}`. Then it gives the ids itself and fetches nothing, and the address that `assign(links={document id: link})` gave for an id is the path that the route's `path` check reads. A run reads the same address.

`p.documents()` lists what the manifest holds, sorted by id, as `DocumentEntry` values with
`id`, `filename`, `category`, `reason`, `metadata` and `content_hash`. A document saved
before categories existed shows the category `unsorted` until the next sync sorts it.

To send a document to another category, use `move`:

```python
p.index.move("legal/contract.pdf", "scans")
```

Only that document runs parse, clean and chunk again, and its old pieces leave the index.
The reason becomes `Chosen when moved`. An unknown document or category raises a
`ValueError` that names the valid ones. Moving a document to the category it is already in
runs nothing.

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
records its name, a hash of its bytes, the id of its pieces, its category, the reason for
that category, and its `metadata` labels if it has any. It also records a hash of the
index settings and the id of the index. `sync` takes `metadata` (labels by document id)
and `categories` (a document id to a category name) for the new files it finds.

The manifest also records a `format_version`. Pandion reads an older manifest as it is and
never rewrites your file just to change it. If the manifest was written by a newer Pandion,
Pandion refuses to read it and tells you to upgrade pandion.

A document keeps its category, reason and labels until you move it. Its checks do not run
again, even when its bytes change. `metadata` is used only for new documents, and
`categories` naming a document that is already in the manifest raises a `ValueError` that
points to `p.index.move`.

Each sync compares the folder with the manifest:

- A new file is parsed, cleaned, chunked and added to the index.
- A changed file is parsed again. Its old pieces leave the index and its new ones go in.
- A removed file has its pieces taken out of the index.
- An unchanged file costs nothing. Every one of its steps is read from the cache.

A document is in `report.changed` when its bytes changed, when its pieces came out
different because the settings changed, or when it was moved. `report.config_changed` is true when the index
settings differ from the last sync. Then only the steps from the first changed setting
on run again, as in [The cache](#the-cache).

Three rules say what a change re-runs:

- Changing a category's settings re-runs only the documents in that category.
- Changing the route moves nothing. It sorts only the files that are new.
- Moving a document re-runs only that document.

Removing a category that documents are in is refused before anything runs, with their
names: `Move them to another category first, or put the category back.` This holds even when your
paths leave those documents out, so move them, or sync without removing the category first. A route that names
a category the pipeline does not have is refused when the file is loaded.

A search in a new process builds each document with the category the manifest recorded,
so it reads the same index the sync made.

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
the folder. A URL in the list is fetched again on each sync and reported the same way
(see [A URL as a document](#a-url-as-a-document)).

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
   `hybrid_rrf` scores each piece `1 / (rrf_k + place)` in each list it appears in, and
   adds the two. `dense_weight` and `bm25_weight` (both 1 by default) multiply each
   list's term, so `bm25_weight: 2` makes the keyword search count twice as much as the
   meaning search. Use that for questions that name exact codes, names or part numbers.
   A weight must be 0 or more, and they cannot both be 0. Weights left at 1 do not
   change a result's id.
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
`llm_rerank`, whose model answers can change. When one of them answers differently, the
steps after it run again on the new answer; when it answers the same, they are `cached`.

To load the default cross-encoder before the first search, call
`pandion.preload_reranker()`. It takes a model name and `pandion.ModelSettings`, like
`preload_embedder`.

### Filter a search

`where=` limits a search to some documents, some pages or one section. `retrieve` and
`ask` both take it:

```python
result = p.retrieve(
    "How do I install it?",
    where={"document": ["guide.pdf"], "pages": [10, 30], "section": "Installing"},
)
```

Each key is optional, and when you give several, a piece must match all of them.

- `document` is a list of documents, by the name `index.run` gave them (such as
  `guides/chunking.pdf`) or by their sha. A name that is not in the index is an error
  that lists the names it has. It needs the upload source, the usual one.
- `pages` is a pair of whole numbers, the first page and the last, both included. A piece
  matches when its pages overlap them, so a piece that runs from page 29 to page 31
  matches `[30, 40]`. A piece with no pages never matches a `pages` filter. Word, HTML,
  Markdown and the other files without pages give such pieces. The search does not fail
  for them: its note says how many pieces it left out for having no page numbers.
- `section` is a heading. A piece matches when one of the headings above it, at any
  level, is exactly this text, with the same capital letters. So `"Installing"` matches
  a piece under "Guide > Installing", and `"Install"` does not. An index whose parser
  found no headings has no sections. pdfium finds none, for example. A `section` filter
  on such an index fails with an error that says so, instead of quietly finding nothing.

A `where` with an unknown key, a wrong type, or pages that are not a pair of whole
numbers from 1 to 2,147,483,647 with the first not after the last, is an error before anything
runs. `pandion.check_where(where)` runs the same check on its own.

The filter is applied inside the index, before the ranking, so a search with `top_k: 20`
still finds up to 20 matching pieces. It applies to vector search, keyword search and
both halves of `hybrid_rrf`. With `query_expansion: prf`, the words added to the keyword
search are also weighed against the matching pieces only.

A filter belongs to a question, so it is never in the pipeline file. The file refuses a
`filters` setting on `retrieve.rewrite`. The filter travels with the question to the
search, so the same question with another filter, or with none, is searched again and
never served the other's results. A search without a filter keeps the id it had before
filters existed.

The index keeps each piece's first page, last page and headings in columns of their own
for this. Version 2 of the `lancedb` step added those columns, so every index built
before it is built once more on its next run. The embeddings come from the embedding
cache, so no text is embedded again.

## Ask a question

`ask` runs the retrieval and then the answer step, in one go:

```python
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
p.index.run("docs/")
answer = p.ask("How big should a chunk be?")
print(answer.text)
```

The `answer` section of the file names the answer step. It takes any registered answer
strategy, built in or your own, except `eval`, which scores retrieval rather than
answering. Two are built in:

- `search` shows the pieces that retrieval found, as they are, with their rank, score
  and pages. It needs no model and no key, so it costs nothing. Its `top_k` is how many
  pieces it shows.
- `chat` sends the pieces and the question to a chat model, which answers using only
  those pieces. Every claim in the answer points at the passage it relied on, and each
  citation is checked against the parsed document. It needs a key, and it is a new model
  call every time, so it is never cached.

A rewrite or answer step is given the first document, as parsed, only when its class
declares a `doc` input, as `llm_rewrite` and `chat` do.

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

- `answer.text`, the output's `payload["text"]` when your own answer step sets one,
  otherwise the chat answer as one text, or the pieces found one after another.
- `answer.output`, the answer step's whole output. The built-in steps set its `kind` to
  `search` or `chat`, and its `payload` holds the pieces, or the answer with its `citations`
  and counts. Your own answer step chooses its own `kind` and `payload`.
- `answer.hits`, what retrieval found, best first.
- `answer.stages`, with `rewrite`, `search`, `rerank` and `answer`, each a `StageResult`
  as in [Search an index](#search-an-index).
- `answer.ok`, which is false if any step failed. A step that fails is reported, not
  raised, and then `output` is None.

**What the chat labels mean.** `chat` labels every part of its answer that says something,
in both citation modes. A part is `cited` when the model cited a piece for it and, with
sentence ids, the cited sentence is close enough to the claim. It is `weak` when the model
cited a sentence that is not close enough. A part the model did not cite is compared with
every sentence of the pieces it read, using the index's own embedder: it is `similarity`
when one is close enough, with that sentence as its citation, and `none` otherwise. With
Claude's own citations, a part Claude cited is `cited`, and a part it did not cite gets the
same check. Claude often splits a sentence where a citation starts, as in "According to
the text, " followed by the cited part. A part like that, which leads into a cited part
without ending a sentence, gets no label of its own. This check costs no second model
call. Without an index there is nothing to compare with, so an uncited part is `none`.
Both built-in prompts ask the model, when the documents do not answer the question or
part of it, to say so in one sentence that starts "The documents do not". A part the
model did not cite that is one such sentence, in any case, is `not_found` in both modes,
with or without an index: the model honestly says the pieces do not answer it, which is
not a fault. A part that goes on with another sentence keeps its usual label, so a claim
after it is still checked, and a part the model cited keeps its usual label however it
starts. With your own prompt, ask for that sentence if you want the label.
The output's `stats` counts each label, `not_found` too, and also gives `claims`, how
many parts say something, and `citing`, how many of those cite a piece, so "2 of 3 parts
cite a piece" is `citing` of `claims`. A `not_found` part is not a claim, so one cited
part and one part not in the documents read "1 of 1 part cites a piece". A part can hold
more than one sentence, or only part of one.

Read the labels with care. Closeness is not proof. The check measures how alike two texts
are, not whether one follows from the other, so "X is not allowed" scores close to "X is
allowed". A `none` label is the one to trust: nothing in the pieces is even close to that
claim. A `cited` or `similarity` label claims more than it can prove. It says the claim
sits near a sentence of the source, not that the source supports it.

Chat's ids changed once in chat version 4 (Pandion 0.6.0), when the built-in
prompts gained the "The documents do not" line. Every built-in chat result id moved then,
so a chat answer stored under an older id is not found by the new one; run the question
again.

With several documents in the index, `chat` finds its citations in the first document by
name, the same rule as for a rewrite. A citation from another document is kept: its
`source_sha` names its own piece's document, its quote is checked against that piece's
text, and its page is the piece's page when the piece is on one page (none when it spans several). Its offsets are in its own document's text.

## Evaluate a pipeline

`pandion.evaluate` asks every question in a question set and says whether the sentence
that answers it came back in the top pieces, at which rank, and, for a miss, where the
answer was lost.

```python
import pandion
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
report = pandion.evaluate(p, "questions.json", top_k=5, documents="docs/")
report.found, report.total            # 10, 12
for q in report.questions:
    q.id, q.found, q.rank, q.lost_at  # "heading-sections", True, 2, None
    q.trace                           # for a miss: why, step by step
report.totals()                       # hit_rate, mrr, recall, mean_rank, median_rank
report.by_tag()                       # the same numbers per tag
report.by_document()                  # the same numbers per document a question names
report.to_dict()                      # all of it as plain JSON
print(report)                         # one line per question, then the totals
```

The pipeline needs a retrieve section. With `documents`, each question searches exactly
those documents (indexed first through the cache when needed), and `p.index` is left as
it was. Without it, the search covers what `p.index.run` or `p.index.sync` indexed last.

`on_event` and `cancel` work as for `p.retrieve`: each event carries the question's id
under `question`, a `question_finished` event follows each question, and a cancel stops
before the next one (`report.cancelled`).

`print(report)` gives one plain line per question and the totals:

```text
heading-sections found at rank 2
table-caption missed. Lost at Chunk. No piece holds the whole answer.
Found 10 of 12 (83%). Mean reciprocal rank 0.71.
```

A question whose retrieval failed prints `error:` and its message, and is not counted.

**The question set.** A JSON file in the format the bundled samples use
(`samples/*/questions.json`), a CSV file with the same columns, or the same list in code:

```json
[
  {
    "id": "two-steps",
    "question": "What are the two steps a retrieval-augmented system takes?",
    "gold_answer": "First it finds passages that look relevant, then it asks a language model to answer from those passages alone.",
    "tags": ["basics"]
  }
]
```

Each question needs `question` and at least one gold passage: `gold_answer`, or a list
in `gold_answers`, copied from the document word for word. `id`, `answer`, `tags` and
`document` (the document the evidence is in) are optional. A question without an `id` is
named by its place in the set, such as `question 3`. The file may also be an object with
a `questions` list, a `version` and a `document`, which every question that names no
document takes. One set can cover several documents: give each question the `document`
its evidence is in, and pass them all in `documents=`. A question that names its
document, by its id, its filename or its content hash, counts as found only when a piece
from that document holds a gold passage in the top `top_k`, and its miss is traced in
that document. A question that names none counts as found when a piece from any document
does. A question naming a document that is not searched is refused before anything
runs: "Question 3 names the document annex.pdf, which is not one of the documents
searched: handbook.pdf, report.pdf." (With a source other than upload, a question names a
document by its location or the location's last part, such as `report.pdf` for
`s3://bucket/report.pdf`; the content is not known before it is read, so there a named
question counts in any document too.) `report.by_document()` gives the totals for the questions naming each document, in
the order the set first names them, as `{"document": its content hash, ...the totals}`,
then one entry with `"document": None` for the questions naming none; each
`q.document` (also in `q.to_dict()`) says which, and `report.to_dict()` carries
`by_document`. The overall totals count every question as before. With one document,
naming it or not gives the same result. In a CSV file, several gold
passages share one cell, separated by `||`. A set with a problem is refused before
anything runs, with a `QuestionSetError` naming the question:
"The question set at questions.json cannot be used: question 3: no question text."
`pandion.evaluation.load_questions` reads a set on its own.
`pandion.evaluation.document_text(pandion.parse("report.pdf", use="pdfium"))` gives the
text gold passages are looked for in, and
`pandion.evaluation.check_questions(questions, text)` says, per gold passage, whether it
is really in that text. `pandion.evaluation.check_questions_across(questions, texts)`
does the same over several documents (`texts` is `{document key: its text}`): a question
whose `document` is a key is checked in that document only, one naming none in every
one, and each gold passage says the document it was found in (`document`, None when it
was not). `pandion.evaluation.documents_named(questions, documents)` says which of
`documents` (as `p.index.indexed()` returns them) each question names, and refuses a name
that is none of them. `pandion.evaluation.paragraph_spans(doc)` says where each
paragraph starts and ends in that text, as (start, end) pairs in order.
`pandion.evaluation.find_gold(golds, texts)` says which of `texts` (pieces in the order
a reader meets them) first holds any gold passage, by the same rule the `eval` step
scores with: a `GoldFound(index, gold, match)`, or None.

**How a question is scored.** By the `eval` step, the same one the playground's
Evaluate page runs. A piece holds the answer when it contains a gold passage exactly,
or after spacing, line-end hyphens, capital letters, curly quotes and ligatures such as
fi are evened out, or with list markers and stray single letters set aside on both
sides. `q.score["match"]` says which (`exact`, `normalized`, `reworded`). `top_k`
(default 5) is how many of the top pieces are checked: an answer below it is a miss.
It cannot check more pieces than the retrieve section returns, so set the search step's
`top_k` (or the last reranker's) at least as high.
With several gold passages, any one counts as found, and `golds_found` out of
`golds_total` feeds recall.

**Where a miss was lost.** `q.lost_at` is the first step that no longer holds the
answer: `parse`, `clean`, `chunk`, or one of the three ways an answer is lost at rank:
`search` (it never came back), `rerank` (the reranker dropped it) and `top_k` (it came
back below the pieces checked). `q.trace` has a one-sentence `finding`, a suggested
`fix`, every step's sentence and evidence, and the `document` it was traced in: the one
the question names, else the first whose pieces hold the answer whole, else the first
whose parsed text holds it. With several rerankers, the trace checks the last one,
whose result was scored.

A retrieval step that fails is reported, not raised: `q.error` names it, and the
question is left out of the rates.

`q.result_id`, also in `q.to_dict()` as `"result_id"`, is the artifact id of the final
retrieval result (the last reranker's, or the search's), so the hits can be read back
by id later. It is None when the retrieval failed.

### Compare with a baseline

`report.against(baseline)` says which questions this run missed that an earlier run
found, and the other way round. The baseline is an earlier report, its `to_dict()`, or
the path of a file that `pandion eval --json` wrote.

```python
before = pandion.evaluate(p, "questions.json", documents="docs/")
# ... change a setting, then run again
now = pandion.evaluate(p2, "questions.json", documents="docs/")
r = now.against(before)          # or now.against("base.json")
r.found_before, r.found_now      # 9, 8
r.newly_missed, r.newly_found    # ["q4", "q7"], []
r.ok()                           # False: a question was newly missed
r.ok(allow=2)                    # True: up to 2 newly missed questions are allowed
print(r)                         # Found 8 of 12; the baseline found 9 of 12. Newly missed: q4, q7.
```

`pandion.evaluation.regression(now, baseline)` does the same when both runs are plain
dicts, such as reports kept as JSON: each needs only `top_k`, and each question's `id`,
`question`, `found` and `error`, with the set's `questions_fingerprint` or every
question's `golds`. `pandion.evaluation.best(reports)` takes reports or their dicts and
gives the places of the best ones.

The `Regression` it returns has these fields:

- `compared` is how many questions both runs asked. `found_before` and `found_now`
  count the found ones among them.
- `newly_missed` and `newly_found` are the ids of the questions whose verdict changed.
- `unmatched` names the questions only one run asked: this run's first, then the
  baseline's.
- `partial` is True when the two runs did not ask the same set, or did not check the
  same number of pieces. `notes` then says so in a plain sentence.
- `notes` holds every plain sentence about the comparison, and `print(r)` prints them
  under the counts.
- `ok(allow=0)` is True when at most `allow` questions were newly missed.

Questions are paired by their `id`. A question the set gave no id (named by its place,
such as `question 3`) is paired by its text, so a reordered set still pairs up. Ids are
paired first, over the whole set; a named question whose id has no partner then falls
back to its text, among the questions still unpaired. A question that could not be
scored in either run is left out, and a note says how many. When
the question sets differ, only the questions both runs asked are compared, and the
note says so. When `top_k` differs, a note says the counts are not like for like.

To tell a changed set from the same one, `report.to_dict()` carries
`questions_fingerprint`, a hash of the questions and their gold passages that does not
depend on their order. It also carries `document_shas`, the searched documents' content
hashes, and `top_k`. When the documents differ, a note says so.

**The noise warning.** Some steps can give a different result each time they run, for
example `llm_rewrite` and `llm_rerank`, which ask a model. When either run used such a
step, `report.nondeterministic` names it, and a note says that a newly missed question
may be noise: the model may simply have answered differently this time. Run it again
before you trust the change. A pipeline without a model step gives the same result
every run.

`pandion.evaluation.best(reports)` gives the places of the best reports in a list,
every one tied for first: the highest hit rate, then the highest mean reciprocal rank.
It is the rule [`compare`](#compare-settings) names its best variant by.

## Questions written for you

A question set takes time to write by hand. `pandion.evaluation.write_questions` asks a
chat model to write one for a document, then checks every question it gets back.

```python
import json
import pandion
from pandion.evaluation import write_questions

doc = pandion.parse("report.pdf", use="pdfium")
result = write_questions(doc, model="claude-haiku-4-5", count=15,
                         credentials={"anthropic_api_key": "..."})
with open("questions.json", "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)
```

The first argument is the parsed document, or its text
(`pandion.evaluation.document_text(doc)`), never a path: you parse first, so the parser
is chosen in one place. Pass the parsed document when you have it, because then the
parts follow its paragraphs (`paragraph_spans`); plain text is split at blank lines.
`model` is a chat model id, the same ids the chat steps take. `openrouter` needs
`model_name`, and `custom` needs `model_name` and `base_url`. Keys go in `credentials`,
under the names a run uses. With no key, the error is the same sentence the chat steps
give, and no error message ever contains a key. `public_only=True` is for a server that
strangers share: it is passed to the model call, so a custom endpoint must be a public
https address, and the no-key sentence does not suggest a server variable.
`document="report.pdf"` names the document the text is: every question written carries
it as its `document`, so questions written for several documents, one call each, can
join one set.

**How it works.** The text is split into `count` parts, each a run of whole paragraphs,
or one part per paragraph when there are fewer paragraphs than `count`. Text between
paragraphs, such as a table or a list, goes with the paragraph before it, so nothing is
left out. Each part is one call to the model, which writes one question, a short answer,
and the passage that answers it, quoted word for word, as JSON. The prompt says the
question must make sense without the part in view and read like something a person would
search for, never naming the document itself. It asks for a gold passage of at least one
full sentence, not a heading, and says the part is document text, not instructions. A part's prompt holds at most 6,000 characters of it
(`MAX_PART_CHARS`): a longer part is sent as whole paragraphs spread evenly from its
start to its end, as many as fit. Each call allows 16,000 output tokens, so a thinking
or reasoning model has room. Then every question is checked, with no further calls:

- **Bounds.** Line breaks and control characters are taken out of the reply. A question
  over 300 characters, an answer over 500 characters, or a gold passage under 6 words (a heading, not a sentence) is
  dropped.
- **The gold passage must be in the document.** It is looked for as `check_questions`
  looks: exactly, then with spacing, quotes, ligatures and capitals evened out. A
  passage that is not there drops the question. This also catches most questions the
  part cannot answer.
- **Copied questions are tagged.** When more than 60% of a question's content words
  (its words without "the", "of" and the like) come from its own passage, it gets the
  tag `copied`. It is kept, but it tests word matching more than search, so look at it.
- **Duplicates are dropped.** A question nearly the same as one already kept (a
  `difflib` ratio above 0.85 on the evened-out text), or with the same gold passage, is
  dropped.
- **A reply that is not the JSON asked for, or was cut off** (the model ran out of
  tokens), is a drop, never an exception.

**What it returns.** The same dict `parse_question_set` returns
(`format`, `version`, `document`, `questions`), so when it has at least one question,
`pandion.evaluate` takes it as it is, or from the file you dump it to. When every
question was dropped, `questions` is empty, and `evaluate` refuses an empty set. Each question has an id (`q1`, `q2` and so on). Three
keys are added, and a question set reader ignores them:

- `dropped`: each dropped question and why, as `{"question", "reason"}`. A reply that
  could not be read has an empty question.
- `usage`: `{"input_tokens", "output_tokens", "model"}`, summed over every call that
  returned. A count
  is None when a server did not report it, never 0. `model` is the one the server says
  it used.
- `parts`: how many parts the text was split into.

It never returns more than `count` questions, and returns fewer when drops leave fewer.
When the first call fails, such as for a rejected key, a wrong model id or an endpoint
that cannot be reached, the error is raised. A call after that which fails is a drop,
with its reason, and the questions already written are still returned.

**Following its progress.** Pass `on_part`, a function that takes two numbers, and it is
called after each part with how many parts are done and how many there are in all, for
example `on_part=lambda done, total: print(f"{done} of {total}")`. It is called for a part
whose call failed too. An exception it raises stops the calls and is raised again from
`write_questions`, so raising one is how a caller stops it early; pandion-api does this
when a run is cancelled.

From the command line, `pandion questions` does the same; see
[The pandion command](#the-pandion-command).

## Compare settings

`pandion.compare` runs a pipeline once per variant of one stage, with everything else
the same, and evaluates each.

```python
import pandion

results = pandion.compare(
    p, "chunk",
    [{"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
     {"use": "recursive_character", "chunk_size": 800, "chunk_overlap": 80},
     {"use": "sentence_window"}],
    documents="docs/", questions="questions.json",
)
for r in results:
    r.variant, r.report.found, r.report.total   # each variant's evaluation
```

The stage is one of `parse`, `clean`, `chunk`, `enrich`, `embed`, `store`, `rewrite`,
`search` and `rerank`. A variant is what the pipeline file takes for that stage: a block,
`"none"` for `enrich` or `rewrite`, a name such as `"bm25"`, a step class such as `RecursiveCharacter(chunk_size=800)`, or for `clean` and
`rerank` a list. Every variant is checked before any runs, and a problem names the
variant: "variant 2: index.chunk (recursive_character) has no setting 'chunk_sise'."

Every variant indexes `documents` into the same store, so the steps above the changed
one run once: comparing three chunkers parses each document once and chunks it three
times. Comparing a retrieval stage builds the index once.

Without `questions`, each result holds the changed step's output, in `r.outputs`: per
document for parse, clean and chunk (`r.outputs["report.pdf"].output.chunks`), or under
`"index"` for embed and store. A retrieval stage needs questions, because without them
nothing is searched. Without questions, `through` stops each variant's index run after
that step, as `index.run(through=...)` does, so comparing ten chunkers with
`through="chunk"` embeds nothing. It must not stop before the varied step (comparing
`chunk` with `through="parse"` is a `ValueError`), and with questions it is a
`ValueError`, because answering needs the whole index. `r.index` is the variant's index run, `r.pipeline` the pipeline
with that stage changed (`r.pipeline.to_yaml()` writes it as a file), and `r.to_dict()`
is all of it as plain JSON. A variant whose index run fails is reported, with
`r.index.ok` false and no `report`.

Categories chosen by hand with `p.index.assign` carry over to every variant.

In a pipeline with categories, comparing `parse`, `clean` or `chunk` sets each variant in every
category. `pandion.evaluation.with_stage(data, stage, block)` does this to a pipeline file's
dict, and `p.index.step_names()` lists the steps `through` can name: `parse`, `clean`,
`clean.N` for as many cleaners as the category with the most has, `chunk` and `index`.

`print(results)` gives one plain line per variant and names the best one: the variant
with the highest hit rate (answers found out of the questions scored), then the one with
the higher mean reciprocal rank. The results are a list, `pandion.Comparisons`; a slice
of it is a plain list.

```text
chunk recursive_character chunk_size=400 chunk_overlap=80: found 9 of 12
chunk recursive_character chunk_size=800 chunk_overlap=80: found 10 of 12
chunk sentence_window: found 8 of 12
Best: recursive_character chunk_size=800 chunk_overlap=80, found 10 of 12.
```

A variant without questions prints `indexed, no questions asked`, and one whose index
run failed prints `the index run failed`. When several variants tie for best, the line
names the others after `tied with`. When no variant found an answer, the last line
says `No variant found an answer.` instead.

`results.best` is the list of best comparisons, every one tied for first, in order. It
is empty when no variant was scored or none found an answer. `results.to_dict()` is
plain JSON with `comparisons`, each comparison's `to_dict()`, and `best`, the places of
the best ones in the list, such as `[1]`.

`on_event` gets every event with the variant's number under `variant` and the number of
variants under `variants`. An evaluation's own fields, such as `total` (the number of
questions) on `question_finished`, are left as they are. `cancel` starts no further
variant. A variant whose index run a cancel stopped prints `stopped`, and one whose
evaluation was stopped partway prints its count followed by `(stopped early)`. Neither
can be the best: when no variant finished, there is no `Best:` line. The last line is
then `Stopped before every variant had finished.` `results.cancelled`, also in
`results.to_dict()`, is one flag for the whole comparison: a cancel stopped it. Each
comparison has its own `r.cancelled`, also in `r.to_dict()`, which says whether a cancel
stopped that variant.

## Speed and cost

Every report has `cost()`: `Retrieval`, `Answer`, `IndexReport` (and so `SyncReport`),
`EvaluationReport`, one `Comparison`, and the `Comparisons` that `pandion.compare`
returns. It says how long the steps took, how many tokens the model steps used, and
about what that cost.

```python
answer = p.ask("How big should a chunk be?", credentials=keys)
answer.cost()
# {"seconds": 1.84, "input_tokens": 2310, "output_tokens": 412, "dollars": 0.0041,
#  "unpriced_models": [], "uncounted_models": [], "steps_run": 5, "steps_cached": 2, "prices_as_of": "2026-10-15"}
```

- `seconds` is the time of the steps that ran in this run, including a step that failed.
- `input_tokens` and `output_tokens` add up what the model steps reported. They are None
  when no step reported any. A local step, such as an embedder or a cross-encoder, gives
  time only. Pandion never guesses a count with a tokenizer.
- `dollars` is an estimate for the steps whose model has a price. It is None when no step
  could be priced.
- `unpriced_models` lists the model ids that used tokens but have no price, such as an
  OpenRouter model or a custom endpoint. Their cost is unknown, so it is never counted
  as 0. A model is found in the table by the id the server reported, then by that id
  without a date at the end (`claude-haiku-4-5-20251001` is priced as
  `claude-haiku-4-5`), then by the id that was sent.
- `uncounted_models` lists priced models whose server did not report both token counts,
  so their calls could not be priced either.
- `steps_run` counts the steps that ran in this run, and `steps_cached` the steps that
  came from the cache. Each cached step is counted once per report, even when every
  question of an evaluation read the same stored index. A step the same report also ran,
  such as a chunk step that a later question reads back, counts only as run.
  A cached step takes almost no time and uses no tokens, so a run
  that reused the cache looks fast and cheap. The two counts show how much of it did.
- `prices_as_of` is the date of the price table, or `"custom"` when you passed your own.

Only steps that ran in this run count. A step that failed after its model call still
counts, with the tokens it recorded, so a failed run never looks free. A search or an
answer also counts the document steps (parse, clean, chunk) it ran or read from the cache
on the way to the index. They are kept in `Retrieval.upstream`, without their outputs,
and only `cost()` reads them.

The prices are in `pandion.llm.PRICES`: US dollars per million input tokens and per
million output tokens, for each Anthropic and OpenAI model Pandion offers, taken from
each provider's published list price on the date in `pandion.llm.AS_OF`. They are the
standard rates. Cached prompts, batch requests and long prompts are billed differently,
so the dollars are an estimate, not a bill. Prices never go in the pipeline file. To use
your own, pass them in the same shape:

```python
answer.cost(prices={"claude-sonnet-5": (2.0, 10.0), "openai/gpt-4o-mini": (0.15, 0.6)})
```

### Part of a run, and several runs together

`cost()` takes `since` and `before`, each a stage name. `since="rerank"` counts only the
steps at that stage or after it, and `before="rerank"` only the steps before it, so the
two split a run in two. The order is the pipeline's: source, parse, clean, chunk, enrich, the index
(`embed`, `store` and `index` all name it), rewrite, search, rerank, answer. A name that
is not a stage raises `ValueError`.

`pandion.total_cost(reports)` is the cost of several reports together, with each step
counted once across all of them. A cached read of a result that another of the reports
ran is not counted, and a cached step that several reports read counts once. It takes
`prices`, `since` and `before` too. `Comparisons.cost()` is `total_cost` of its variants.

This is how to compare variants fairly. `compare` runs the shared steps for the first
variant only, and the later variants read them from the cache, so each variant's whole
`cost()` depends on its place in the list. `Comparisons.varied_from` is the stage that
`compare` was told to vary. `pandion.varied_costs(reports, since=...)` gives each
variant's cost from that stage on, as if the variant had run on its own:

```python
results = pandion.compare(p, "rerank", ["mmr", "cross_encoder"], docs, questions)
for c, own in zip(results, pandion.varied_costs(results, since=results.varied_from)):
    print(c.settings, own)
print("shared", pandion.total_cost(results, before=results.varied_from))
```

Some steps from the varied stage on are the same in several variants. Two lists of
rerankers or cleaners that start the same way make the same first results, and a step
that does not read the varied one, such as the question's rewrite, is the same in every
variant. One variant runs such a step and the others read it from the cache.
`varied_costs` charges it to every variant that uses it, with the time and tokens of the
run that made it, so a variant's cost does not depend on the order. `total_cost` still
counts what was really spent, each step once.

Two more rules. A step that no variant ran this time, because an earlier run had already
stored it, is counted only as cached. When every shared step came from the cache, the
shared cost has `steps_run` 0 and `seconds` 0: say that the shared steps came from the
cache rather than that they were free. Loading a model the first time it is used is timed
in the step that loads it, so the first variant to use a reranker or an embedder can look
slower. `pandion.preload_reranker` and `pandion.preload_embedder` load them before the run.

`pandion eval` and `pandion compare` print the cost as one line (see
[The pandion command](#the-pandion-command)).
pandion-api returns each step's `usage` and each report's `cost` in its JSON (see
[pandion-api.md](pandion-api.md#speed-and-cost)).

## Running a pipeline from an app

An app, such as a web server or a command line tool, can do everything through
Pandion's public API. This section lists what it needs. `pandion.evaluate` and
`pandion.compare` take `on_event` and `cancel` too, so a long evaluation can show
progress and be stopped.

`p.extras()` names the extras a pipeline needs (what `pandion install` installs).
`pandion.preload_parser('docling')` loads a parser's models before the first run, as
`preload_embedder` and `preload_reranker` do for theirs.

### Settings forms

`pandion.catalog()` lists every strategy, built in or your own, stage by stage, with its
summary and its settings as a JSON schema with defaults. `pandion.defaults()` names the
strategy a new pipeline starts with for each required part. `pandion.explain(stage, use,
settings)` says in plain words what one strategy will do with those settings, and warns
when they make no sense, without running anything. `catalog()` returns a copy each time,
so changing it changes nothing in Pandion. It also has a `route` entry, which lists the
route checks in the same shape. A check is not a strategy, so `explain` refuses
`"route"` with a `ValueError`.

```python
import pandion

schema = pandion.catalog()["chunk"]["recursive_character"]["config_schema"]
pandion.defaults()["search"]                                     # "hybrid_rrf"
pandion.explain("chunk", "recursive_character", {"chunk_size": 100, "chunk_overlap": 200})
# {"settings": "...", "warning": "Overlap must be smaller than the chunk size ...", "blocking": True, ...}
```

### Results by id

Every `StageResult` has an `artifact_id`. `p.result(id)` reads that result back from the
store later, for example when a page asks for one card's output: a dict for every result
but an index, whose result is its folder. An id that is not a result id, or that has no
stored result, is a `KeyError`.

A server that keeps many pipelines under one folder does not need a pipeline to read a
result. `ResultStore` reads, describes and clears what is stored under a `path`:

```python
from pandion import ResultStore

results = ResultStore("./my-index")
results.info(result_id)    # {"id": ..., "type": "chunk_set", "meta": {...}}
results.get(result_id)     # the result, as p.result(result_id) gives it
results.clear()            # {"results": 12, "bytes": 48210, "complete": True}
```

An id that is not 64 lowercase hex characters, or that nothing is stored under, is a
`KeyError` whose message names the id but not the folder, so a server can hand it back.
`clear()` removes `artifacts/` and `embeddings/` and keeps `sources/`. Clearing while a
run is writing under the same path is not supported: the run may fail or leave some of
its results behind. A result cleared while it is being read is a `KeyError`, as if it
was never stored.

### One step, progress, stop, keys and re-runs

`index.run` takes five optional keywords. Without them it runs exactly as before.

```python
import threading

stop = threading.Event()               # set it from another thread to stop the run
report = p.index.run(
    "report.pdf",
    through="chunk",                   # stop after this step; report.index is then None
    on_event=print,                    # every event, with its "document" and "step"
    cancel=stop,
    credentials={"openai_api_key": key},   # for this call only; never stored
    force=True,                        # run every step again, even when it is stored
)
```

An app that keeps uploads under names of its own passes a mapping of document id to file,
so results keep the names people gave their files.

- `through` names the step to stop after: `parse`, `clean` (the last cleaner of the
  document's category, or parse when it has none), `clean.1`, `clean.2` ..., or `chunk`.
  A cleaner the document's category lacks stops it at its last cleaner. A step no
  category has is a `ValueError`. `index` is the whole run.
  The steps above it come from the cache when they ran before.
- `on_event` is called with each event as a plain dict, ready for JSON: `run_started`,
  `node_started`, `node_finished` (with `cache_hit`, the result's `artifact_id` and
  `usage`, the same value as `StageResult.usage`),
  `node_failed` (with the error and `usage`, what the step recorded before it failed),
  `node_skipped` (a step after one that failed),
  `warning` (with a `message`), `run_cancelled` and `run_finished`. To an event about
  one step, Pandion adds `document` (the document id, or None for the index) and
  `step`. Events about several steps name each one as `{"document": ..., "step": ...}`:
  `run_started` has `steps` (every step of the run) and `selected_steps` (the ones
  this run asked for), and `run_cancelled` has `skipped_steps`. The raw ids in
  `node_id`, `nodes`, `selected` and `skipped` are internal and may change; use the
  named fields. If the callback raises, the run stops and the exception reaches your
  code. The one exception is an event a strategy emits itself through `ctx.emit` inside
  `apply`: an error the callback raises there is caught like any other step error, so
  that step fails instead of the whole run stopping.
- `cancel` is checked between steps: a step that is running finishes, the rest are
  reported with status `skipped`, and `report.ok` is False.
- `credentials` are the model keys for this call, as for `p.retrieve`.
- `force` runs every step that was asked for again, even when its result is stored.

### Search the files a question is about

On a server many people share, one store holds everyone's results, so a search must say
which files it covers. `p.retrieve` and `p.ask` take `documents=`, the same argument
`index.run` takes, and search the index built from exactly those files. Files not yet
indexed with these settings are indexed first; files that were are read from the cache.
It does not change what `p.index` holds. `on_event`, `cancel`, `credentials` and `force`
work as for `index.run`. On a server many people share, always pass `documents=`;
without it the search covers whatever was last indexed in the process.

```python
answer = p.ask("What does chapter 2 say?", documents={"report.pdf": "/uploads/0f3a.pdf"},
               on_event=send_to_browser, cancel=stop)
```

`documents=` decides which index is searched. `where=` narrows the search inside that
index to some of its documents, pages or a section, as in
[Filter a search](#filter-a-search). Its `document` names must be among `documents=`.

## Three ways to write a pipeline

A pipeline can be written as a YAML file, as a dict for each stage, or as classes in
code. All three give the same pipeline: the same settings give the same artifact ids and
the same results whichever way they are written, so they share one cache. The playground's Starter
pipeline is [`samples/starter.yaml`](../samples/starter.yaml): a good first file to copy.
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
stage when you call them, as in [Try one stage at a time](#try-one-stage-at-a-time).

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
[`examples/pandion/run_template.py`](../examples/pandion/run_template.py) runs a pair with
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
  format in [Documents other than PDFs](#documents-other-than-pdfs) for docling), says which
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

## The cache

An artifact's id is a hash of its recipe: the strategy, its settings and its inputs. Run
the same files with the same pipeline file again and every step is read from the
`artifacts/` folder instead of being run. The second run's statuses are all `cached`.

Change one setting and only the steps from that point on run again. Changing
`chunk_size`, for example, reuses the parse and the clean, and builds new pieces and a
new index. The embedding cache also keeps each embedding by the model and the text, so a
text is embedded once. `pandion.ResultStore(path).clear()` empties it.

A step marked `cacheable = False`, such as `llm_rewrite`, `llm_rerank` or the `chat`
answer, runs on every run and keeps one id, and the latest run's result is stored under
it. A step that reads from such a step adds a hash of what it actually returned to its
own recipe. So when the rewrite comes back in new words the search runs again under a new
id, and when it comes back the same the stored search is reused.

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

`models.public_endpoints_only` is for a server that strangers share. When it is true, a
step that calls a custom OpenAI-compatible endpoint accepts only a public https address
and follows no redirects, so a visitor cannot make the server call an address on its own
network. It also guards a URL given as a document (see
[A URL as a document](#a-url-as-a-document)). It changes no result.

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

## The pandion command

The `pandion` command runs a pipeline file without writing any Python. It uses only
Pandion's public API, the same calls an app makes, so what it prints is what `Pipeline`
returns.

```bash
pandion validate pipeline.yaml
pandion strategies --stage chunk
pandion index pipeline.yaml report.pdf notes/
pandion retrieve pipeline.yaml "What is chunking?" --documents report.pdf
pandion ask pipeline.yaml "What is chunking?" --documents report.pdf
pandion eval pipeline.yaml questions.json --documents report.pdf
pandion compare pipeline.yaml --vary chunk.chunk_size=200,400,800 report.pdf --questions questions.json
pandion install pipeline.yaml --print
pandion init my-project --index text --query balanced
pandion questions report.pdf --model claude-haiku-4-5 --count 15 --out questions.json
```

**`pandion validate FILE`** reads the file and checks every step, with no run. It prints
`pipeline.yaml is a valid pipeline.`, or the reason it is not, such as
`pandion: The pipeline file has no index section.`

**`pandion strategies [--stage STAGE] [--json]`** lists every strategy by stage, each with
its summary, and a `route` group for the route checks. `--stage chunk` shows one stage.
`--json` prints only the names, as JSON.

**`pandion plugins [--json]`** lists every extension point that is loaded: its kind, its name,
the module it came from and its level, which is `stable` or `provisional`. Add `--plugins a,b`
to see your own modules in the list. `--json` prints a list of objects with the keys `kind`,
`name`, `module` and `level`.

**`pandion index FILE DOC... [--sync] [--through STEP]`** indexes files and folders. With
local files (the `upload` source, the default) it runs `p.index.sync`, so it remembers the
documents it indexed for the next command; with any other source it runs `p.index.run`. It
prints one line per document and step, then the index:

```text
report.pdf  source  executed  2 ms
report.pdf  parse  executed  120 ms
report.pdf  chunk  executed  4 ms
index  lancedb  executed  310 ms
```

`--through chunk` stops every document after that step (`parse`, `clean`, `clean.2`,
`chunk` or `index`), so there is no index line, and nothing is remembered. `--sync` also
says, per document, `added`, `changed`, `removed` or `unchanged` since the last index.

**`pandion retrieve FILE QUESTION [--k K] [--documents DOC...]`** searches the index and
prints the hits, one per line, as the rank, the score and the start of the piece:

```text
1. 0.8231  The capital of France is Paris. It is on the Seine.
```

`--k` is how many hits the last step keeps; without it the file's `top_k` holds.

**`pandion ask FILE QUESTION [--documents DOC...]`** prints the answer's text: the chat
answer, or the pieces found when the answer step is `search`.

`--documents` names the documents to search, indexing them first through the cache when
needed. Without it, `retrieve` and `ask` search the documents the last `pandion index`
indexed, so name every document each time you index. A pipeline whose source is not local
files remembers nothing from one command to the next, so name the documents again.

**`pandion eval FILE QUESTIONS [--top-k K] [--documents DOC...] [--json] [--baseline BASE [--allow N]]`** runs
`pandion.evaluate` on a question set (JSON or CSV, as in
[Evaluate a pipeline](#evaluate-a-pipeline)) and prints the report as Pandion prints it:
one line per question, then the totals. `--top-k` is how many of the top pieces are
checked; left out, it is the `eval` step's default `top_k` (5), as for `pandion.evaluate`. A last line gives the run's cost (see
[Speed and cost](#speed-and-cost)), for example:

```text
Cost: 1.84 s, 2,310 in / 412 out tokens, about $0.0041 (estimate, prices as of 2026-10-15); 2 of 7 steps cached; no price for openrouter/auto
```

A part that is unknown is left out rather than shown as 0: a pipeline with no model step
shows only the time and the cached steps. A priced model whose server sent no token count
is named as "no token count for ...". `--json` prints the report's `to_dict()`
instead, with the `cost()` dict under `"cost"`. It exits with 1 when a question could not
be scored.

**`--baseline FILE [--allow N]`** compares the run with an earlier one, as
[`against`](#compare-with-a-baseline) does, and prints one more line, such as
"Found 8 of 12; the baseline found 9 of 12. Newly missed: q4, q7.", followed by any
notes. It exits with 1 when more than `N` questions were newly missed (0 when `--allow`
is left out). Save a baseline with `--json`; there is no other way to save one. The
baseline file is checked before anything runs, and a missing one exits with 2. In CI:

```bash
pandion eval pipeline.yaml questions.json --json > base.json      # once, on the main branch
pandion eval pipeline.yaml questions.json --baseline base.json --allow 1   # on every change
```

With `--json`, the comparison is under `"regression"`.

**`pandion compare FILE --vary SPEC DOC... [--questions QUESTIONS] [--top-k K] [--json]`**
runs `pandion.compare`: the pipeline once per value of one setting, indexing `DOC...`
each time, so every step above the changed one comes from the cache. It prints one line
per variant, each followed by that variant's cost line, and, with `--questions`, the best
one. `--top-k` is how many of the top pieces are checked, the `eval` step's default when
left out, as for `pandion eval`. `--json` prints `to_dict()`, with each variant's `cost()` under `"cost"`.

`--vary` takes `stage.setting=a,b,c`, and each value is read as YAML, so `200` is a
number and `null` is no value:

- `chunk.chunk_size=200,400,800` changes one setting of the chunk step.
- `search.use=dense,bm25` changes the strategy itself; the other settings go back to
  that strategy's own.
- `clean.2.min_chars=20,40` changes a setting of the second clean step. Clean and rerank
  are lists of steps, so name the step by its place, from 1. (`min_chars` belongs to
  `drop_short`, the cleaner in the own_strategies example, where
  `--vary clean.1.min_chars=20,200` works as is.)

The stages `--vary` can name are parse, clean, chunk, enrich, embed, store, rewrite,
search and rerank. Without `--questions`, compare only indexes, and shows each variant's step; it
cannot compare a search, rewrite or rerank step that way, because nothing is searched.

**`pandion install FILE [--print]`** installs the extras the file needs, as described in
[Install what a file needs](#install-what-a-file-needs).

**`pandion init FOLDER [--index NAME] [--query NAME] [--questions FILE] [--overwrite]`**
writes a project folder from an index and a query template, as described in
[Start a project](#start-a-project), then prints the files it wrote and the next steps.

**`pandion questions DOC --model ID [--count N] [--out FILE] [--model-name NAME] [--base-url URL] [--parser NAME] [--overwrite]`**
parses DOC (with `pdfium` unless `--parser` names another), has the model write up to
`--count` questions (default 15) with
[`write_questions`](#questions-written-for-you), and writes the set to `--out`
(default `questions.json`). It then prints how many questions were kept, each one
dropped and why, how many are tagged `copied`, and the tokens used. To change a
question, edit the file. `--model-name` and `--base-url` are for `openrouter` and
`custom`. An `--out` file that already exists is refused, before any model call, unless
`--overwrite` is given. When no question was kept, it prints the summary, writes no
file, and exits with 1. An error from the model also exits with 1, with the key taken
out of the message.

### --plugins

Every command takes `--plugins a,b`: modules to import before the file is read, from the
current folder first, so the strategies they register can be named in the file. It works
like `plugins:` in the file, for a file that does not list them. A module that cannot be
imported is an error that names it. The worked example in
[examples/pandion/own_strategies/](../examples/pandion/own_strategies) has a strategy at
every step in its `my_strategies` folder. From that folder:

```bash
pandion strategies --plugins my_strategies --stage chunk   # per_block is in the list
pandion validate copy.yaml --plugins my_strategies         # copy.yaml: pipeline.yaml without its plugins: line
pandion index copy.yaml notes/bees.md notes/bread.md notes/tides.md --plugins my_strategies
pandion ask copy.yaml "What causes the tides?" --documents notes/bees.md notes/bread.md notes/tides.md --plugins my_strategies
```

Without `--plugins`, the second command fails, because `per_block` and the others are not
registered.

### Keys and exit codes

A model's key comes from the environment, never from the file or a flag:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` and
`OPENROUTER_API_KEY`. Only the ones that are set are passed on, and a key is never
printed.

The command exits with 0 when it is done, 1 when a step failed (the line for that step
says why) or `pandion eval --baseline` found more newly missed questions than `--allow`,
and 2 when the file, a flag or the baseline file is wrong (the message starts with
`pandion: `).

## Index stores

An index store is the place where an index keeps its rows. Pandion defines one contract, `IndexStore` and `Collection`, and you can write a store for the database your team already runs. This contract is **Stable**, and so is `register_store`. The memory store that comes with Pandion is the reference, and LanceDB and Qdrant move onto the contract in later releases.

A row (`IndexRow`) holds an id, the document id and version, the text, the vector, the `roles` that may see it, some metadata, and the chunk as JSON. A row with an empty `roles` list is visible to nobody. A search takes a filter built from `Eq`, `In`, `AnyOf` and `And`, and the store must apply it before it ranks. Roles use `AnyOf("roles", (...))`, so every store must support `any_of`.

A store says what it can do in `Capabilities`: whether it can change one document at a time, whether it has text search, which filters it has, and which metrics it has. Pandion refuses a pairing the store cannot serve. A store with no text search cannot be used with BM25 or hybrid retrieval.

```python
from pydantic import BaseModel
from pandion.extend import register_store


class MySettings(BaseModel):
    url: str = "http://localhost:6333"


@register_store
class MyStore:
    name = "mine"
    settings_model = MySettings

    def __init__(self, settings: MySettings): ...
    # capabilities, create, open, drop and list, as in pandion.index_store.IndexStore
```

Prove your store with the conformance suite, the same one the memory store passes. It includes the check that a row with no roles is never returned.

```python
from pandion.testing import store_conformance

store_conformance(lambda: MyStore(MySettings()))
```

`pandion plugins` lists every store, with the kind `store`.

## Write your own strategy

Every stage takes a strategy, and you can write your own. A strategy is a class that
subclasses `pandion.extend.Transform`. You say which stage it is for, what it reads, and
what its settings are, and you write `apply()`. Then `@register` makes its `name` work in
a pipeline file and in `Pipeline(...)`, the same as a built-in.

[`examples/pandion/own_strategies/`](../examples/pandion/own_strategies) writes one
strategy for every stage, from the source to the answer, and runs them from a pipeline
file and from code. It needs no download and no network. Its README walks through it
stage by stage.

Every strategy follows the same pattern:

1. A settings model: a pydantic `BaseModel` where every field has a default, so the step
   runs with no settings at all. A strategy with no settings still has an empty model.
2. A class that subclasses `Transform[YourSettings]` and sets:
   - `name`, the name you write after `use:`;
   - `stage`, one of `Stage.SOURCE`, `PARSE`, `CLEAN`, `CHUNK`, `INDEX`, `QUERY`,
     `RETRIEVE`, `RERANK` or `USE_CASE`;
   - `inputs`, the ports it reads, each a `PortSpec` (see the table below);
   - `output`, which the stage fixes (a parser must make a `PARSED_DOC`, and so on);
   - `config_model`, the settings model;
   - `summary`, one plain sentence saying what it does.
3. `apply(self, inputs, config, ctx)`, which gets the inputs by port name, the settings as
   an instance of your model, and the run's context, and returns the stage's output. A
   payload model, such as a `ParsedDoc`, and a plain dict, such as
   `doc.model_dump(mode="json")`, both work.
4. `@register` on the class.

A mistake in the class, such as a stage with the wrong output or a setting with no
default, is a `TypeError` when the module is imported, so it never reaches a pipeline.

The ports each stage reads:

| Stage | `stage =` | Reads (port: what) | Returns | Example in `my_strategies/` |
|---|---|---|---|---|
| source | `Stage.SOURCE` | nothing; the document is the `location` setting | `raw_file(ctx, data, filename)` | `source.py`: `text_file` |
| parse | `Stage.PARSE` | `file`: a dict with `sha`, `filename`, `path` and `mime` | `ParsedDoc` | `parse.py`: `markdown` |
| clean | `Stage.CLEAN` | `doc`: a `ParsedDoc` | `ParsedDoc` | `clean.py`: `drop_short` |
| chunk | `Stage.CHUNK` | `doc`: a `ParsedDoc` | `ChunkSet` | `chunk.py`: `per_block` |
| store | `Stage.INDEX` | `chunks`: a list of `ChunkSet`, one per document (`variadic=True`) | a function that writes into a folder | `store.py`: `jsonl_store` |
| rewrite | `Stage.QUERY` | nothing; the question is the `text` setting; `doc` if declared | `Query` | `rewrite.py`: `lowercase` |
| search | `Stage.RETRIEVE` | `index`: the store's folder; `query`: a `Query` (`ambient=True`) | `RetrievalResult` | `retrieve.py`: `jsonl_search` |
| rerank | `Stage.RERANK` | `result`: a `RetrievalResult` | `RetrievalResult` | `rerank.py`: `shortest_first` |
| answer | `Stage.USE_CASE` | `result`: a `RetrievalResult`; `doc` if declared | `Output` | `answer.py`: `bullets` |

The embedder is not a stage, so it is not in the table: `embed.py` (`letter_counts`) is its
example, under [Your own embedder](#your-own-embedder). These are every stage
`pandion.catalog()` lists, so the example covers each one. The `route` group of the
catalog holds checks, not stages, and `route.py` (`is_invoice`) is the example of one.

`Stage.ENRICH` and `Stage.QUERY_TRANSFORM` are reserved: no strategy uses them yet, and they are kept so result ids stay stable.

An `ambient=True` port is found for you: the `query` port is filled by the rewrite step
without any wiring. Everything in the table, and `register`, `set_note`, `set_usage`, `get_embedder`
and `raw_file`, comes from `pandion.extend`.

A strategy that calls a model at an address its settings name checks the address with
`guard_endpoint(base_url, public_only=...)`, which raises `EndpointRefused` for a private
or plain-http address when only public ones are allowed, and builds an OpenAI client's
arguments with `openai_client_kwargs`.

A short parser, for a start:

```python
from pathlib import Path

from pydantic import BaseModel
from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, register

class NoSettings(BaseModel):
    pass

@register
class TxtLines(Transform[NoSettings]):
    name = "txt_lines"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = NoSettings
    summary = "One block per line of a text file."

    def apply(self, inputs, config, ctx):
        lines = Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines()
        return ParsedDoc(elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i)
                                   for i, t in enumerate(lines) if t.strip()])
```

If your strategy or embedder needs a pip extra, set `extra = "<name>"` on the class, and `pandion install` installs it for any pipeline file that uses it.

### Your own embedder

An embedder is set under `embed:` and not as a step, because the store embeds the pieces
with it and the retriever embeds the question with the same one. To add one, subclass
`pandion.extend.Embedder`, give it a name and its sizes, and write `_embed()`, which returns
one vector per text. The same `@register` adds it, and then `embed: {use: letter_counts}`
picks it.

```python
from pandion.extend import Embedder, register

@register
class LetterCounts(Embedder):
    name = "letter_counts"
    model_id = "local/letter-counts"
    revision = "1"
    native_dim = 26
    max_seq_len = 10_000

    def _embed(self, texts, kind):
        vectors = []
        for t in texts:
            counts = [t.lower().count(chr(97 + i)) for i in range(26)]
            length = sum(c * c for c in counts) ** 0.5 or 1.0  # no letters: avoid dividing by zero
            vectors.append([c / length for c in counts])
        return vectors
```

`kind` is `"document"` for a piece and `"query"` for a question. Return vectors of length 1
(divide each by its length), because search compares them as if they were. A name that is already
taken is refused.

### Your own source

By default each document is a local file given to `p.index.run`. To read documents from
somewhere else, such as a database, a web page or a bucket, write a source step and set it
under `index.source:`. Its settings must have a `location: str = ""` field: each item you
pass to `p.index.run([...])` becomes one document, its id is the item as text, and the
source is run with the item as its `location`. A source without a `location` field is
refused. The source returns `raw_file(ctx, data, filename)`, which keeps the bytes in the
`sources/` folder and hands the parser the same file record the built-in `upload` source does.

```python
from pydantic import BaseModel
from pandion.extend import ArtifactType, Stage, Transform, raw_file, register

class NoteSettings(BaseModel):
    location: str = ""

@register
class Note(Transform[NoteSettings]):
    name = "note"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = NoteSettings
    summary = "Treats the location itself as a short text document."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, config.location.encode("utf-8"), "note.txt")
```

```yaml
index:
  source: {use: note}
  parse: {use: txt_lines}   # your own parser, from the example above
```

In code it is the `source=` keyword:
`Pipeline(path="./index", source="note", parse="txt_lines", chunk="recursive_character", embed="fake-deterministic", store="lancedb")`.

`p.index.sync` works with local files only (the `upload` source); `p.index.run` works with
any source.

A source can hand over labels with `raw_file(ctx, data, filename, metadata={"cms_type": "invoice"})`.
A route that has a check (such as `metadata`) runs the source step first, so the labels can
choose the document's category. That step is a cache hit when the run goes on.

A source's result is cached by its settings, so by `location`: the same location is read
once and reused. If the content at a location can change, set `cacheable = False` on the
class, and it is read again on every run. The parse after it runs again only when what the
source read has changed; when it is the same, the stored parse and everything after it are
reused.

To search after a run with your own source, call `p.retrieve` or `p.ask` in the same process
as `p.index.run`. Only `upload` has a manifest, written by `p.index.sync`, that a later
process can read.

### A store and the retriever that reads it

A store says what it can be searched by in `provides`, and a retriever says what it needs
from the store in `requires`, on its `index` port. The built-in `lancedb` store provides
`{"backends": ["dense", "fts"], "format": ["lancedb"]}`, and the built-in retrievers
(`dense`, `bm25` and `hybrid_rrf`) each need the backends they search and the `lancedb`
format, because they open a LanceDB table. Pandion compares the two when the pipeline is
read, so a mismatch is refused before anything runs, for example: "retrieve.search uses
'dense', which needs a store with backends dense and format lancedb, but index.store uses
'my_store', which has backends dense and format jsonl." So a new store in another format
brings its own retriever, whose `requires` asks for what that store provides. Name the
format on both sides: it stops your retriever pairing with a store whose files it cannot
read, such as `lancedb`.

```python
class JsonlStore(Transform[JsonlStoreConfig]):
    stage = Stage.INDEX
    provides = {"backends": ["dense"], "format": ["jsonl"]}
    ...

class JsonlSearch(Transform[JsonlSearchConfig]):
    stage = Stage.RETRIEVE
    inputs = {"index": PortSpec(ArtifactType.INDEX), "query": PortSpec(ArtifactType.QUERY, ambient=True)}
    requires = {"index": {"backends": ["dense"], "format": ["jsonl"]}}
    ...
```

A store returns a function that takes a folder and writes the index into it. Do the work,
such as embedding, in `apply()`, so a failure is reported as the store's failure, and let
the function only write files. Pandion keeps the folder with the other results, and the
retriever gets the same folder as `inputs["index"]`, so it reads its files with
`Path(inputs["index"]) / "pieces.jsonl"`. A store with an `embedder` setting gets it from
`embed:`, so write the embedder's name into the folder too, and the retriever can embed
the question with the same one. In `apply()`, get the embedder with the run's model
settings, `get_embedder(name, ctx.extras.get("models"))`, so a model is found where the
pipeline's `models:` section says. To make a new embedder revision build a new index, return
`get_embedder(config.embedder).fingerprint()` from the store's `fingerprint()`.

### A rewrite and an answer

A rewrite step has a `text: str = ""` setting, and Pandion puts the question there when
you call `p.retrieve` or `p.ask`, so the file never sets it. It returns a `Query`: put the
question to search with in `text`, and the question as typed in `original`, which the
answer uses.

An answer step returns `Output(kind=..., payload={...})`. Put the answer as text in
`payload["text"]`, and `p.ask(question).text` gives it back.

A rewrite or an answer gets the parsed document only when it declares a `doc` input:
`inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True, required=False)}`. With
several documents, it gets the first one by id.

Any step can record one plain sentence about what it did with `set_note(ctx, "...")`, for
example a cleaner saying how many blocks it removed. The note is shown with the step's
result, as `StageResult.note`.

A step that calls a model can record what the call used with
`set_usage(ctx, usage, model, requested_model=None)`. `usage` is
`{"input_tokens": ..., "output_tokens": ...}` and `model` is the model id the call went
to. Leave a count as None when the server did not send it. Pass the model id the server
reports when it gives one (`pandion.llm.complete` returns it as `Completion.model`), and
the id you sent as `requested_model`. When the two differ, the usage keeps both, so
`cost()` can still find a price. The usage is shown with the
step's result, as `StageResult.usage`, and in its `node_finished` event, or its
`node_failed` event when the step raises after recording it. A cached run of the step
shows None, since it called no model.

## Loading your strategies

`pandion.plugins.load(project_dir, modules)` is the one loader, also exported as `pandion.extend.load_plugins`. It imports the built-in
strategies, then the installed packages, then your modules, and puts `project_dir` on the
import path only while it does so. Pipeline files and the command line use it; serve, sync and eval will too. Any load
failure stops the process with a `PluginError` that names the module, and a name registered
twice fails with a sentence that names both modules. A `pipeline.yaml` runs code, because
its `plugins:` list imports modules, so never load one from a source you do not trust.

These are the extension points and how steady each one is. Pandion is 0.x, and a Stable
contract changes only after a deprecation in the changelog.

| Level | Extension points |
| --- | --- |
| Stable | Source, route check, access rule, index store, conversation store, Policy |
| Provisional | Step plugins, executor events, online evaluators |

A strategy only works by name once the module that registers it has been imported. There are
three ways to make that happen.

1. Import it in code, before you build the pipeline: `import my_company.rag_steps`.
2. List it under `plugins:` in the pipeline file. A YAML file cannot import anything, so the
   CLI, or a server that reads the file, needs to be told which modules to load.

   ```yaml
   plugins: [my_company.rag_steps]
   path: ./my-index
   index:
     parse: {use: txt_lines}
   ```

   Each module is imported from the folder the pipeline file is in first, the same way a
   relative path is read from it, so a module next to the file works from any folder,
   including with `pandion install`. A module that cannot be imported is a `ConfigError`
   that names the module and the error. `Pipeline.from_dict(data, base=...)` reads the
   same `plugins` key, and looks for the modules in `base` first.
   The `pandion` command also takes `--plugins a,b` for a file that does not list them; see
   [--plugins](#--plugins).

   `pandion install` imports the modules to read the file, before it installs anything.
   So import a heavy library, such as one that loads a model, inside `apply()` and not at
   the top of the module: then `pandion install` can run before that library is
   installed.
3. Ship it as a package. Add an entry point in the `pandion.strategies` group, and Pandion
   loads the package the first time it looks up a strategy:

   ```toml
   [project.entry-points."pandion.strategies"]
   qdrant = "pandion_qdrant"
   ```

   A package that fails to load gives a warning that names it, and the other strategies keep
   working.

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
pipeline file problem is a `pandion.ConfigError`, a `ValueError`.

Every problem in a pipeline file or dict is a `ConfigError` whose message is one line: an
unknown strategy names the strategies there are, and a value a setting does not accept
names the step, the strategy and the setting, for example
`index.chunk (recursive_character): chunk_size: Input should be a valid integer.` An app can
show the message as it is. It need not read the message to place it: when the problem is one
step's, `exc.step` is that step's place in the pipeline file (`index.chunk`,
`index.clean.2`, `retrieve.rerank`, `index.store`, `answer`). Run events name steps by role
instead (`chunk`, `clean.2`, `rerank.1`, and `index` for embed and store), so the two are not
the same text. `exc.use` is its strategy, and `exc.settings` lists
each refused setting with its own sentence, as `{"field", "message"}`. `exc.to_dict()`
gives all of it as JSON. A problem that is no one step's has `step` and `use` None. Calling one stage with a bad value (`pandion.chunk(doc,
use="recursive_character", chunk_size="big")`) raises a `ValueError` with the same kind of
sentence.

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

[`examples/pandion/own_strategies/`](../examples/pandion/own_strategies) writes a
strategy for every stage and runs them from a pipeline file (`run_yaml.py`) and mixed with
built-in steps in code (`run_mixed.py`). A test runs both, and the install check runs
`run_yaml.py` and `pandion install --print` on its pipeline file against the built package.
