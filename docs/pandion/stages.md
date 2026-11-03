# Run one stage at a time

Parse, clean, chunk and rewrite, each run on its own.

[Manual index](index.md) | Previous: [install](install.md) | Next: [pipeline-file](pipeline-file.md)

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
[Models](install.md#models)):

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
