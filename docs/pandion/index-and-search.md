# Build, search and ask

Build an index, keep it up to date, search it, ask a question, and roll out a new one.

[Manual index](index.md) | Previous: [pipeline-file](pipeline-file.md) | Next: [evaluate](evaluate.md)

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
- `report.index`, the `StageResult` of the index. Its `.output` is the index binding (store, collection and descriptor).
- `report.ok`, which is false if any step failed or was skipped.

```python
report.documents["guides/chunking.pdf"].stages["chunk"].output   # the pieces
report.documents["guides/chunking.pdf"].stages["clean.1"].note   # what the cleaner removed
report.index.output                                              # the index binding
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

If you remove a category from the pipeline, its documents are not refused. The next sync
sorts them again with your route, and they show up in `report.changed`. `add` and `move`
still refuse a pipeline whose manifest names a category that is gone.

Only one sync runs at a time for an index folder. A sync makes `sync.lock` in the folder and
removes it when it ends, even when it fails. If a lock is there, `sync` raises `SyncBusy`
(a `ValueError`, imported from `pandion.synclock`) that names the file. If no sync is running, delete the file and run it
again. `add` and `move` take no lock.

A file that cannot be indexed does not stop the sync. A PDF behind a `.docx` name, or a file
whose parse fails, is left out of the index and the manifest. It is listed in `report.failed`,
which maps the document id to a one-line reason, and the next sync tries it again. The other
documents are committed, and they cost only cache hits. A document that was indexed before
and now fails is dropped from the manifest, so you must set its category and labels again once
it is fixed. If every file fails, nothing is
written. `report.ok` means every step ran for the documents that were committed.
`report.complete` also needs `failed` to be empty, so use it for an exit code:

```python
report = pipeline.index.sync("docs/")
raise SystemExit(0 if report.complete else 1)
```

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

A route that names a category the pipeline does not have is refused when the file is loaded.

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
(see [A URL as a document](stages.md#a-url-as-a-document)).

### Sync from a source

A folder is not the only place documents live. `index.sync` also takes a `Source`, a
small object that lists its documents and reads one on request. `Source` is a Stable
contract, so a source you write keeps working across releases. Pandion ships one, the
`files` source, which reads any location that [fsspec](https://filesystem-spec.readthedocs.io)
understands: a local folder, or a bucket.

```python
from pandion import Pipeline
from pandion.document_sources import FilesSource

report = Pipeline.from_yaml("pipeline.yaml").index.sync(FilesSource("gs://bucket/docs"))
print(report.added, report.changed, report.removed)
```

Install it with `pip install "pandion[files]"`. A bucket also needs its own fsspec
package, such as `gcsfs` for `gs://` or `s3fs` for `s3://`. Pass `storage_options={...}`
for keys and other settings.

Each entry a source lists has a `doc_id`, a `version` and some `metadata`:

- The `doc_id` is the file's path inside the location, with forward slashes on every
  platform.
- The `version` is a short text that changes when the file changes. The `files` source
  uses the store's ETag, generation or checksum when it has one, and otherwise the
  modified time and the size.
- The `metadata` becomes the labels of a document that is new to the index. It holds the
  `path`, the `content_type`, and any text values the store reports as custom metadata.
  A document already in the index keeps its labels.

The source lists its entries without reading any bytes. Pandion then reads only the new
entries, and the ones whose version is different from the one in the manifest. An entry
with the same version is not read at all, and a file that was touched but has the same
bytes is reported as unchanged. If a stored copy has gone missing, that entry is read
again.

A source that lists nothing is refused with a sentence that says so, and the manifest
and the index are left as they were. This stops a wrong location, or a bucket that is
briefly unreachable, from wiping the index. The pipeline's source step must be
`upload`, as for a folder. To write your own source, give a class a `name`, a `list()`
and a `read(doc_id)`, and add it with `register_source` from `pandion.extend`. [`zip_source.py`](../../examples/pandion/extensions/zip_source.py)
is a tested example that reads the documents inside a zip file.

#### Name the source in the pipeline file

A team that syncs on a schedule can name the source in the file instead of in code. Add
a top-level `source:` block: `use` is a registered source, and every other key is a
setting of that source. A relative `location` is read from the folder this file is in, not
from where you run the command.

```yaml
path: ./index
source:
  use: files
  location: gs://bucket/docs
index:
  # ...
```

`Pipeline.from_yaml("pipeline.yaml").index.sync_source()` then runs `sync` with that
source, and `pandion sync pipeline.yaml` does the same from the command line (see
[The pandion command](cli.md#the-pandion-command)). A source name or setting that does not
exist is refused when the file is read. The block is not part of the index recipe, so
adding it does not rebuild any index. It is separate from `index.source`, which is the
pipeline's source step and stays `upload` for a sync. A file without a `source:` block
makes `sync_source` raise a `ValueError` that says so.

Each row the index keeps then names its document. The row's metadata gets `source_id`, the
document id (for a folder, its path), and `source_<label>` for each label the source gave
(`source_content_type`, `source_path` and so on). A label key is lower-cased, and any
character that is not a letter, digit or underscore becomes `_`. The `roles` label is access
data and is not copied. Only the document id and the labels reach a row, never a source's
settings or `storage_options`. A document you sync or add as a file gets `source_id` too, its name,
so its citations can name it. This changes the id of every built-in index
result once, so an index built before this version rebuilds its index step on the next sync
(the parsing and embedding stay cached).

Keep keys and passwords out of the file, because a pipeline file is usually committed.
`storage_options` is accepted by the `files` source, but fsspec reads credentials from the
environment (for example `GOOGLE_APPLICATION_CREDENTIALS` or `AWS_ACCESS_KEY_ID`), and that
is where they belong. A source that lists nothing is refused here too, with no override.

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
   [Rewrite a question](stages.md#rewrite-a-question).
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
  reranker also `prior_rank` and `prior_score`, which say where it stood before. When the
  index kept the document's id and labels (see [Sync from a source](#sync-from-a-source)),
  `chunk.metadata["source"]` holds them, for example `{"id": "hr/pay.pdf", "owner": "hr"}`.
  An index built before that has no `source` key.
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
  for them; it leaves them out.
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
cache, so no text is embedded again. Version 3 builds through the LanceDB index store and
rebuilds the same way.

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
text, and its page is the piece's page when the piece is on one page (none when it spans
several). Its offsets are in its own document's text. A citation also has a `source`, the
document's id and labels (empty when the index kept none).

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

[Architecture](../architecture.md#artifacts-and-the-cache) explains the hash in detail.

## Rolling out a new index

Every sync builds its rows into a new collection in the store. The name is made of two
parts: the first 16 characters of the recipe hash (a hash of the index settings), then 12
characters of the id of the index step, which also covers the documents and the embedding
model revision. A change to the settings, the documents or the model therefore makes a new
collection, and two document sets of one recipe never overwrite each other. After a
sync that worked, `manifest.json` names the collection in `index_collection`.

A server asks whether its own collection is there with `p.index.index_status()`:

```python
status = Pipeline.from_file("pipeline.yaml").index.index_status()
if not status.ready:
    print(status.reason)   # one sentence that says what to do
```

It is ready only when the manifest names a collection, the store has it, the collection was
built from the same recipe as this file, the embedding model has the same revision, and the
collection is in a format this Pandion reads. It never writes, parses or embeds, and it loads
no model.

The collection from before the last sync stays, so a server on the previous image or file
keeps working and rolling back is redeploying it. Each sync writes the collection it replaced
into `retired` in `manifest.json`, with the time. After a sync that worked, a retired
collection that is neither the new one nor the previous one is dropped once it was replaced
more than 7 days ago. The 7 days count from the replacement, not from when the collection was
built, and only collections this manifest retired are dropped. A collection that another
pipeline built in the same folder or the same Qdrant prefix is never touched, whatever its
age. One limit: a collection is named after the recipe and the documents, so two copies of
the same pipeline over the same documents (staging and production, say) share one collection
if they share a folder or a prefix, and the first to move on drops it. Give each copy its own
folder or prefix. The stored index record of a dropped collection goes with it. Nothing reloads a running
server onto a new collection: start it again from the new file. A server's first ready
`index_status()` remembers its collection, and later checks keep to it, so an old server stays
ready while a new one is deployed beside it.

The name also pins a run. An evaluation or a comparison searches one collection, and its name
cannot change under the run. `pandion-api` reports it as `index_collection` (on an evaluation,
and on each comparison variant), so you can check which index a result came from.

If the folder of the index is deleted, or its collection was cleaned up while the cache
still holds the record, the next sync builds the index again from the cached embeddings.
