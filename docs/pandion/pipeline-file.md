# The pipeline file

Every field of the YAML pipeline file, including categories and routes.

[Manual index](index.md) | Previous: [stages](stages.md) | Next: [index-and-search](index-and-search.md)

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

# Optional. The source `pandion sync` reads: `use` is a registered source (files), the
# other keys are its settings. Not part of the recipe. Keep credentials in the
# environment, not here. A relative location is read from the folder this file is in.
# See Name the source in the pipeline file.
source:
  use: files
  location: gs://bucket/docs

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
file gives the same artifact ids and shares a cache. [Strategies](../strategies.md) lists
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
[`route.py`](../../examples/pandion/own_strategies/my_strategies/route.py) in
[`examples/pandion/own_strategies/`](../../examples/pandion/own_strategies) has this check.

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
[Strategies](../strategies.md#enrich) for every setting and the built-in prompt.
