# pandion-api

pandion-api serves Pandion over HTTP. Every endpoint that takes a pipeline takes the
pipeline file's shape as JSON, the same dict `Pipeline.from_dict` reads, so a pipeline is
written one way everywhere: in a YAML file, in code, in a request and in a browser.
Everything a particular site wants to limit (who may read a document, how big an upload
may be, how many runs may work at once) is one `Policy` object. The default allows
everything.

It lives in this repository as a workspace package (`packages/pandion-api/`) and is not
on PyPI yet. RAG Playground's server is pandion-api with the playground's own `Policy`,
plus the playground's teaching routes.

## Contents

- [Run it](#run-it)
- [Where it keeps files](#where-it-keeps-files)
- [Endpoints](#endpoints)
- [Runs](#runs)
- [Site rules: the Policy](#site-rules-the-policy)
- [What a request cannot set](#what-a-request-cannot-set)
- [The playground on pandion-api](#the-playground-on-pandion-api)
- [Errors](#errors)

## Run it

```python
# serve.py
from pathlib import Path

from pandion_api import ApiSettings, create_app

app = create_app(ApiSettings(data_dir=Path("./pandion-data")))
```

```bash
uvicorn serve:app
```

`ApiSettings` takes `data_dir` (the one folder every request runs under), `models` (a
`pandion.ModelSettings`: the model folder, `download` and the device), `prefix` (where the
routes are mounted, for example `/api/v2`) and `title`.

[examples/pandion-api/](../examples/pandion-api) runs a server like this one and a client
that validates a pipeline, uploads a document, indexes it, asks a question and evaluates,
in Python and as curl commands.

## Where it keeps files

Every pipeline a request sends runs with `data_dir` as its `path`, so Pandion keeps
`sources/` (each document once, by its fingerprint), `artifacts/` (every step's result)
and `embeddings/` (the embedding cache) there. pandion-api keeps each document's record
in `sources/.meta/` and its question set in `sources/questions/`. A file is kept as
`<sha256><suffix>`; only a plain suffix such as `.pdf` comes from the name a request
sends, so a name never chooses where a file goes. The same bytes are stored once: an
upload under another name writes no second file. A name ending in `.part` is refused
with a 400, because a stored file with that suffix would look half-written.

## Endpoints

| Method and path | Does |
|---|---|
| `GET /health` | `{"status": "ok", "pandion": <version>, "pandion_api": <version>}` |
| `GET /strategies` | `{"stages": ..., "defaults": ...}`: every strategy by stage with its settings as a JSON schema (`pandion.catalog()`, as the Policy shows it), and the strategy a new pipeline starts with per part (`pandion.defaults()`) |
| `POST /explain` | `{"stage", "use", "settings"}` gives what that strategy will do with those settings, in plain words (`pandion.explain`). Nothing runs. |
| `POST /pipelines/validate` | `{"config": <pipeline>}` gives `{"ok": true, "problems": [], "details": [], "config": <the pipeline in the file's shape>, "yaml": <text>}` or `{"ok": false, "problems": [<sentence>], "details": [...]}` (see [Errors](#errors)), where `yaml` is the pipeline as a file Pandion reads, with `path: ./pandion-index`. The file holds the pipeline as it ran; a site rule may refuse changed prompts before any file is made |
| `GET /documents` | the documents this caller may read, by name: `sha`, `filename`, `size`, `content_type`, `origin_url` for a URL document, plus what the Policy's `describe` adds. Never cached. |
| `POST /documents` | multipart `file`: keeps it by its fingerprint and returns its record. The same bytes twice are one document. A file whose extension no parser here reads (such as `.xlsx`) is a 415 before anything is kept; the formats are the ones the parsers declare (`provides["formats"]`): PDF, Word, PowerPoint, HTML, Markdown, text, PNG and JPG. |
| `POST /documents/url` | `{"url"}` (at most 2,000 characters): fetches the page once (`pandion.extend.fetch_url`), then keeps it exactly like an upload and returns the same record plus `origin_url`. See [URL documents](#url-documents). |
| `DELETE /documents/{id}` | `{"sha", "deleted"}`: deletes the file, its record and its question set, if the Policy agrees |
| `GET /documents/{id}/file` | the file's own bytes. Never cached. |
| `GET /documents/{id}/pages` | each page's size in PDF points: `[{"n", "width", "height"}]` |
| `GET /documents/{id}/pages/{n}?scale=1` | the page as PNG, `scale` above 0 and at most 8, lowered so the image stays within 25 million pixels |
| `GET /documents/{id}/pages/{n}/find?text=` | where the text (1 to 2,000 characters) is on the page: `{"rects": [[left, bottom, right, top], ...], "matched": "exact" or "normalized" or "none"}` |
| `POST /documents/{id}/questions` | multipart `file`, a question set as JSON or CSV: checks every gold passage against the document's text (a PDF as pdfium reads it; Word, PowerPoint, HTML, Markdown and text as docling reads them, with no model; `parser` and `parser_note` say which), keeps the set if the Policy keeps sets, and reports per question whether each passage was found. A set over 1 MB is 413; a set that cannot be used (more than 500 questions, more than 20 gold passages in one, a file that cannot be read) is 400 with its sentence; a document whose text cannot be read, an image (it would need OCR models), or a PDF or an image behind another format's name ("this file is named .md but holds a PDF, so its text cannot be checked") is 415. |
| `POST /questions` | multipart `file`, one question set for several documents, and a `documents` field per document (its sha): each question may name its `document` by filename or sha. Each gold passage is checked in the document its question names, or in every one for a question naming none, each read as for `POST /documents/{id}/questions` (`parser` lists the parsers used). Each question's row names its document's sha (`document`, `null` when it names none) and each gold passage the sha of the document it was found in (`null` when it was not); `set` is the set as read, each question's `document` its sha or empty, so a page can keep it when the server does not. If the Policy keeps sets, the set is kept split by document: each document's named questions against it, and the questions naming none against every one, so removing a document loses none of them; a document the set has no question for loses the set it had. A question naming another document is 400 with its sentence; the other refusals are those of `POST /documents/{id}/questions`. |
| `GET /questions?documents=...` | the sets kept against these documents (one `documents` parameter per sha) as one, as an evaluation without questions asks them: `{"documents", "count", "questions", "filenames"}`, where `filenames` names the files the kept sets were read from, each once. A named question's `document` is the sha of the document it is kept against; a question naming none has an empty one and comes once, however many of the documents keep it. |
| `GET /documents/{id}/questions` | the set kept for the document, or `null` |
| `DELETE /documents/{id}/questions` | remove it: 204 |
| `POST /documents/{id}/questions/generate` | `{"model", "count"?, "model_name"?, "base_url"?}`: a model writes up to `count` test questions (default 15) for the document, read as the upload check reads it, one call a part (`pandion.evaluation.write_questions`). A run: 202 `{"run_id"}`. See [Questions written for you](#questions-written-for-you). |
| `POST /golds/find` | `{"golds": [...], "texts": [...]}`: which of `texts`, pieces in the order a reader meets them, first holds any gold passage, by the eval step's own rule (`pandion.evaluation.find_gold`): `{"found": {"index", "gold", "match"}}`, or `{"found": null}`. At most 20 golds of up to 10,000 characters each, and 100 pieces of up to 1,000,000 characters together (a 422 past them). A single piece has no cap of its own, so a long one is looked through whole. These caps keep one call under about half a second of work, so the route needs no rate limit. Nothing runs or is kept. |
| `POST /evaluations/against` | `{"report", "baseline"}`, each an evaluation's result or the part of it a comparison reads (`top_k`, the totals, the fingerprint, the documents, `nondeterministic`, and each question's `id`, `question`, `found` and `error`): the run compared with the baseline as `report.against(baseline)` compares them (`pandion.evaluation.regression`), with `best`, `pandion.evaluation.best` of `[baseline, report]`. Each text is held to the caps the other routes use (a question at most 2,000 characters, an `error` at most 10,000 so a long failure line still compares, each gold passage at most 10,000, all of a run's gold passages together at most 1 MB, an `id`, the fingerprint, each document sha and each `nondeterministic` step at most 500, at most 500 documents and 50 steps): a 422 past them. Nothing runs. |
| `POST /runs` | `{"config", "documents": [id, ...], "through"?, "force"?}`: index the documents, or stop each after one step (`parse`, `clean`, `clean.N`, `chunk`; `index` is the whole run). 202 `{"run_id"}`. |
| `GET /runs/{run_id}` | the run's status, its whole event log, and once it ended its `result` |
| `GET /runs/{run_id}/events` | the events as server-sent events; reconnect with `Last-Event-ID` or `?last_event_id=N` |
| `POST /runs/{run_id}/cancel` | stop the run between steps: 202, or 409 when it already ended |
| `POST /ask` | `{"config", "documents", "question", "k"?, "answer"?, "force"?, "where"?}`: search the documents for the question (at most 2,000 characters; `k` 1 to 100), and answer it unless `answer` is false. `where` narrows the search, as `where=` does in the package: `{"document"?: [id, ...], "pages"?: [first, last], "section"?: "Installing"}`. Its documents are ids, and each must be one of `documents`. Pages are whole numbers from 1 to 2,147,483,647, first not after last, and a piece matches when its pages overlap them. A piece with no pages never matches. `section` is a heading matched exactly; on an index without headings (pdfium) the search fails and says why. An unknown key, a wrong type or a bad page pair is a 422. A run: 202 `{"run_id"}`. |
| `POST /evaluations` | `{"config", "documents", "questions"?, "top_k"?}`: search for every question and say whether its answer came back, and for a miss the step that lost it (`pandion.evaluate`). Without `questions`, the sets kept against the documents. A run; its result is the report's `to_dict()` plus its `cost`. |
| `POST /comparisons` | `{"config", "stage", "variants", "documents", "questions"?, "top_k"?, "through"?, "question"?, "answer"?}`: run the pipeline once per variant of one stage (at most the Policy's `max_variants`, ten by default) and evaluate each with the questions sent (`pandion.compare`). Without `questions` it is index only, and `through` can stop each variant after a step, as for `POST /runs`. A run; its result names the best. `question` (one question, no gold passage, at most 2,000 characters) instead of `questions` runs each variant's search (or, with `answer: true`, its answer) and returns the results unscored, as `{"comparisons": [{"stage", "variant", "ok", "cancelled", "retrieval" or "answer", "cost", "varied_cost"}], "best": [], "cancelled", "varied_from", "shared_cost", "cost"}`; `best` is then empty. Both kinds carry `varied_from`, `varied_cost` and `shared_cost` (see [Speed and cost](#speed-and-cost)). Sending both `question` and `questions` is a 400, and so is `through` with `question` (a comparison on one question searches, so it cannot stop after an index step) or `answer: true` without `question`. |
| `GET /results/{id}` | a stored result's `id`, `type` and `meta` (a `result_id` from a run) |
| `GET /results/{id}/payload` | the result itself; for an index, the description its store left (LanceDB's backends and counts); a chunk set comes with `stats`, its numbers as `pandion.chunk.stats` sums them up |
| `POST /chunk-stats` | `{"ids": [id, ...]}` (1 to 50 chunk set results): the sets summed up as one by `pandion.chunk.stats`, counts as totals and sizes over every piece; a result that is not a chunk set is a 422. Compare uses it for a chunker run over several documents. |
| `DELETE /cache` | remove every stored result and the embedding cache, keep the documents: `{"results", "bytes", "complete"}`. 409 while a run works. |
| `GET /settings/models` | where the server's own key for each provider comes from (`env`, or `none`; the Policy may name others), never a key |
| `POST /settings/models/check` | `{"provider", "base_url"?}`: whether the key this request would use works, with one call that costs no tokens (a model listing, or OpenRouter's key endpoint): `{"ok", "source", "error"}`. A custom endpoint needs `base_url`, which must pass the same address check as a run; an unknown provider is 422. The key is never echoed, and an error has it taken out. |
| `POST /trace` | why one question missed, followed step by step down a finished run's results (`pandion.evaluation.trace`) |

A document this caller may not read is answered exactly like one that does not exist: 404,
with the same fixed sentence, which never repeats the id the request sent. A page
number past the last page is 404, and a `scale` or `text` outside its range is 422.
pdfium is not thread-safe, so every page request and every question-set check holds
`pandion_api.pages.PDFIUM_LOCK`; anything else in the same process that uses pdfium on
request threads should hold it too. The page and find routes read PDFs only: for a Word,
HTML, Markdown, text or image document they are a 415.

### URL documents

`POST /documents/url` takes one link. The route asks the Policy first
(`check_fetch(url, request)`, for example a rate limit), then, inside the Policy's
`fetch_slot(request)` (for example one of a few slots), fetches the page with
`pandion.extend.fetch_url`, with `public_only` set to the Policy's
`public_endpoints_only(request)` and the byte cap set to its `max_url_bytes(request)`
(20 MB by default). The page then takes the upload's own path: `check_document`, the
store, the record and `on_uploaded`. The store's lock is held from `check_document` to
`on_uploaded`, for an upload too, so two requests at once cannot both pass a cap that
counts records. The record also keeps the link as `origin_url`, and the response gives
it back; a Policy may move it out of the record in `on_uploaded` (the playground keeps it
per browser).

The page is fetched once. Every later route (runs, ask, evaluations, questions, pages)
takes the stored id, as for an upload, and reads the stored file. Nothing is fetched
again for a question.

The status follows the refusal's `kind` (`pandion.extend.FetchRefused.kind`), not its
words. A refusal is the fetch guard's own sentence, which never repeats the URL or anything the
page sent:

| Status | When |
|---|---|
| 400 | the link is not `http://` or `https://`, or its host name is not valid |
| 403 | with `public_only`: the address is not on the public internet, or it is not https on port 443 |
| 413 | the page is larger than `max_url_bytes` |
| 415 | the page sent a type the fetcher does not take (only HTML, PDF, Word, text, PNG and JPG) |
| 502 | the page answered with an error status, could not be reached, or redirected more than 3 times |
| 504 | the page took longer than 10 seconds |

A Policy's own refusals, from `check_fetch` or `check_document`, keep their own status.

## Runs

An index run, a question, an evaluation and a comparison are all runs. The request is
checked first (a bad pipeline is a 422, a document this caller may not read is a 403, a
`through` that names no step is a 400), then answered 202 with a `run_id`, and the work
happens in the background. Its events are Pandion's own (`node_started`, `node_finished`
with the step's `document` and `step`, `node_failed`, `run_finished`), plus `queued` and
`unqueued` when the Policy limits how many runs work at once, and a last `stream_end`. An
index run's `result` gives, per document and step, its `status` (`executed`, `cached`,
`failed` or `skipped`), its `strategy` and its `result_id`.

A question's `result` gives the index it read, each retrieval step (`rewrite`, `search`, and
`rerank`, a list) with its `result_id`, the `hits`, and when answered the `answer` step, its
`text` and its `output`. The documents are indexed first, through the cache, when they were
not yet. Its kind is `ask`, or `retrieve` when `answer` is false. A pipeline with no
`retrieve` section, or with no `answer` section when `answer` is true, is a 422 before
anything runs.

### Speed and cost

Every step in a result has `usage`: what its model call used, or null. A step that calls
no model (a parser, an embedder, a search) has null, and so does a step that came from
the cache, because it used nothing in this run. `usage` holds only token counts and model
ids, never a key or a path:

```json
"rerank": [{"stage": "rerank", "strategy": "llm_rerank", "status": "executed",
  "usage": {"input_tokens": 1840, "output_tokens": 12, "model": "claude-haiku-4-5"}, ...}]
```

Every report has `cost`, which is Pandion's `cost()` with its own price table (see
"Speed and cost" in [pandion.md](pandion.md#speed-and-cost)). An index run, a question
(searched or answered) and an evaluation have one `cost` for the whole result. A
request cannot send its own prices.

A comparison splits its cost so that the order the variants ran in does not change it.
The first variant runs the steps that every variant shares, and the later ones read them
from the cache, so each variant's whole `cost` depends on its place in the list. Both
kinds of comparison, with questions and on one question, return the same fields:

- `varied_from`, on the list, is the stage the comparison varies, such as `"chunk"`.
- `varied_cost`, on each variant, counts only the varied step and the steps after it,
  as if that variant had run on its own (`pandion.varied_costs`). A step there that
  another variant ran, and this one read from the cache, is charged to this one too. It
  is the number to compare variants by.
- `shared_cost`, on the list, counts the steps before the varied one that the run used,
  each once, whichever variant ran it. On a comparison on one question that includes the
  document steps the search ran on the way to the index.
- `cost`, on the list, is every variant together, with each step counted once. Each
  variant also keeps its whole `cost`.

When every shared step came from the cache, `shared_cost` has `steps_run` 0, `seconds` 0
and `steps_cached` above 0. A page should then say that the shared steps came from the
cache, not that they took no time. A step that no variant ran this time, because an
earlier run had already stored it, counts only as cached. Loading a model the first time
it is used is timed in the step that loads it; preloading the model avoids that.

```json
"cost": {"seconds": 1.84, "input_tokens": 2310, "output_tokens": 412, "dollars": 0.0041,
  "unpriced_models": [], "uncounted_models": [], "steps_run": 5, "steps_cached": 2,
  "prices_as_of": "2026-10-15"}
```

A model with no price in the table, such as a custom endpoint's, is listed in
`unpriced_models`, and its tokens are counted but not priced. When nothing in the result
was priced, `dollars` is null. A priced model whose server sent no token count is listed
in `uncounted_models`.

An evaluation's events carry the question's id under `question`, with a `question_finished`
event after each. A comparison's carry the variant's number under `variant`. A comparison on one question
carries `variant` (from 1) and `variants` (how many there are) on every step event, as with questions. Every variant
is checked like a pipeline before anything runs, so a variant the Policy refuses is
refused at once. A variant is taken as `pandion.compare` takes it: a bare name is
`{"use": name}`, and one block for `clean` or `rerank` is a list of one. A question set
in the request is held to the caps of an uploaded one (over 1 MB is 413; more than 500
questions, or more than 20 gold passages in one, is 400 with its sentence). The Policy's
`check_question_count` may refuse fewer: an evaluation by its questions, a comparison with
questions by its variants times its questions.

A Policy can cap the runs one owner has working or waiting (`max_runs_per_owner`). A run
past it, on any route that starts a run, is a 429: "You already have 2 runs going. Wait
for one to finish, or stop one."

A question that names its `document` (by filename or sha) is found only in a piece from
that document, and a question naming none in a piece from any; the result's
`by_document` has the totals per document a question names, then for the questions naming
none, and each question its `document` (the sha, or `null`). A question naming a document
the request does not send is a 400 before anything runs: "Question 1 names the document
bees.pdf, which is not one of the documents searched: report.pdf." The same holds for a
comparison's questions.

An evaluation sent without questions asks those of the sets kept against its documents,
in the order the documents are listed. A kept question that names a document is about the
document it is kept against, so it is found only there. An id that two documents' sets both use is
prefixed with each document's name (`report.pdf: capital`), and the kept sets together
hold at most 500 questions (400 past that). An evaluation with no questions at all is a
400. A comparison asks only the questions it is sent: without them it is index only,
and a comparison of a `rewrite`, `search` or `rerank` step without them is a 400. A
pipeline with no `retrieve` section cannot be evaluated, nor compared with questions
(422). A stage that cannot be compared is a 400, and so is a `through` sent with
questions, one that names no step, or one that stops before the varied step.

A document in a run is named by the filename it was uploaded under, so the same bytes
under the same name give the same result ids however often they are uploaded. Two
documents in one run cannot share a name. The same bytes uploaded by two callers are one
record, so its name is the latest uploader's file name. When the store did not keep the
name's suffix (see Documents), the name's dots become `_`, so Pandion never keeps a copy
under that suffix.

A model's key comes from the request's header for its provider (`X-Anthropic-Api-Key`,
`X-OpenAI-Api-Key`, `X-Custom-Api-Key`, `X-OpenRouter-Api-Key`), else from the server's
environment variable, as the Policy's `key` decides. It is never stored or logged, and it
is scrubbed from every event and result.

A finished run (finished, cancelled or failed) is kept in memory for one hour after it
ended, with its events and its result, and the server keeps at most the 200 most recent
finished runs: past that the oldest finished run goes first. A run that works or waits
its turn is never dropped. A dropped run's state, events and cancel are a 404, the same
as a run that does not exist. A step's results stay in the cache, readable by id
(`GET /results/{id}`), after its run is dropped.

A run belongs to whoever the Policy's `run_owner` names when it starts. To anyone else
its state, its events and its cancel are a 404, the same as a run that does not exist.
The default Policy names no one, so anyone with the `run_id` may follow it. Every error a
run shows (a failed step's `error`, in its event and in the result, and a crash's
`run_error`) goes through the Policy's `scrub` after the keys are taken out.

### Questions written for you

`POST /documents/{id}/questions/generate` has a model write a question set for one
document. It is a run, like an evaluation, so it counts against the same limits
(`max_active_runs`, `max_runs_per_owner`, `run_owner`) and no request is held open while
the model works, which takes about a minute for 20 questions. After each part there is a
`part_finished` event with `number` (parts done) and `total` (parts in all). The result
is the dict `write_questions` returns, as it is: `format`, `version`, `document`,
`questions`, `dropped`, `usage` and `parts`. Each question's `document`, and the set's,
is the document's sha. The server does not keep the set. The reader
looks it over, then uploads the questions they keep with
`POST /documents/{id}/questions`, so `GET /documents/{id}/questions` is the same after
the run as before it.

These are refused before the run starts, in this order. An unknown or unreadable document
is a 404. A `count` under 1 or over 50 is a 422. Then the Policy's
`check_question_count("generation", count, request)` may refuse fewer; the playground's
demo allows at most 25, with a 400 that says so. A `model` that is not a chat model id is
a 422. The Policy's `check_provider` may refuse the model's provider. A `custom` model
whose `base_url` is not a public https address is a 403 where `public_endpoints_only` is
true. A missing key is a 400 with the Policy's `missing_key` sentence. When the first
model call fails, for example for a rejected key or an unknown `model_name`, the run ends
with `ok` false and a result of `{"error": ...}`, scrubbed of keys and by the Policy's
`scrub`. A document whose text cannot be read, or an image, ends the run the same way, with the sentence the
upload route gives as a 415. Cancelling the run stops it after the part in progress,
and no further model call is made. A cancel that comes during the last part does not
stop it: the set is already paid for, so the run finishes with it.

## Site rules: the Policy

Subclass `pandion_api.Policy` and override what your site needs. A method that refuses
raises `fastapi.HTTPException` with the status and the sentence the caller should see.

| Method | Default | Called |
|---|---|---|
| `dependencies()` | `[]` | FastAPI dependencies run on every route |
| `can_read(sha, request)` | `True` | the list, a document's file, pages and questions (404 when False), and a run on it (403) |
| `check_upload(file, request)` | reads it all | `POST /documents`: return the bytes, or raise to refuse. Read no more than you accept. |
| `check_document(data, filename, request)` | takes any bytes | `POST /documents` after `check_upload`, and `POST /documents/url` after the fetch, before anything is kept: raise to refuse. One place for the rules on what a document may be. |
| `check_fetch(url, request)` | allows | `POST /documents/url` before anything is fetched: raise to refuse. A fetch that then fails still came through here. |
| `fetch_slot(request)` | does nothing | `POST /documents/url`: a context manager the fetch runs inside, left even when the fetch fails; raise HTTPException in it to refuse, for example when every slot is taken |
| `max_url_bytes(request)` | 20 MB | `POST /documents/url`: a larger page is a 413 |
| `on_uploaded(document, request)` | nothing | with the store's lock held, after the record is written |
| `on_delete(sha, document, request)` | 404 without a record, else `True` | with the lock held: `True` deletes the file, `False` keeps it |
| `describe(document, request)` | `{}` | keys added to each document in the list |
| `private(sha, request)` | `False` | a page image's Cache-Control: private when True |
| `document_name(sha, request)` | `None` | the name of a stored file with no record (one seeded into a fresh store), used by runs and `POST /questions`; `None` names it by its stored file, `<sha>.pdf` |
| `keeps_question_sets(request)` | `True` | `POST /documents/{id}/questions`: False checks the set and keeps nothing |
| `max_active_runs()` | None (no limit) | when a run starts: past the limit it waits its turn and logs `queued` |
| `strategies(catalog, request)` | the catalog as it is | `GET /strategies`; return a changed copy to hide a strategy or a choice |
| `check_run(config, request)` | allows | before any pipeline runs or validates; `config` is the file's shape with the server's path and models, and holds each value as the request sent it (see below) |
| `public_endpoints_only(request)` | `False` | every pipeline: a custom model endpoint must then be a public https address |
| `check_clear_cache(request)` | allows | `DELETE /cache` |
| `max_variants(request)` | 10 | `POST /comparisons`: more variants than this is a 422 |
| `check_question_count(kind, count, request)` | allows | before an evaluation (`kind` "evaluation", `count` its questions), a comparison with questions (`kind` "comparison", `count` its variants times its questions) or a model writing questions (`kind` "generation", `count` the questions asked for) starts: raise to refuse |
| `max_runs_per_owner(request)` | None (no limit) | when a run starts: an owner (`run_owner`) who already has this many runs working or waiting gets a 429 |
| `run_owner(request)` | None (anyone) | when a run starts, and on its state, events and cancel: a run with an owner is a 404 to anyone else |
| `scrub(text)` | the text as it is | on a `ConfigError`'s problem sentence, on the problem and 404 sentences of `POST /explain`, and on every error a run shows (see [Errors](#errors)) |
| `not_readable` (attribute) | "This document is not available." | the 403 a run gets for a document `can_read` refuses |
| `not_keeping_note` (attribute) | "This server checked your questions but did not keep them." | the report's note when a set was not kept |
| `server_key(provider)` | the environment variable, else `(None, "none")` | a run's keys, and `GET /settings/models` |
| `key(provider, request)` | the header, else `server_key` | a run's keys, and the key check |
| `missing_key(provider)` | names the header and the variable | the key check's error when there is no key |
| `check_provider(provider, request)` | allows | `POST /settings/models/check` |
| `credentials(request)` | every provider whose `key` resolves | every run |
| `on_startup(app)`, `on_shutdown(app)` | nothing | once each, around serving |

A document's record may hold more keys than a client is shown: a Policy keeps what it
needs there (for example who uploaded the file) through `on_uploaded`, and reads it back
as `document.extra`. Hold `pandion_api.documents.SIDECAR_LOCK` (or `DocumentStore.lock`)
around any change you make to a record yourself.

RAG Playground's own Policy, rule by rule, is in
[The playground on pandion-api](#the-playground-on-pandion-api).

## What a request cannot set

A pipeline in a request runs with the server's folder and models, whatever it says:
`path` is `ApiSettings.data_dir`, `models` is `ApiSettings.models`, and
`models.public_endpoints_only` is what the Policy says. A request that lists `plugins` is
refused, because importing a module a request names would run code the request chose.
The refusal comes before Pandion reads the pipeline, so nothing is imported. The server
loads its strategies itself: from its own code, or from installed packages through the
`pandion.strategies` entry point. A source strategy installed that way with a `location`
setting can name any location, a server folder or an address, so a site that installs
one must refuse the locations it does not allow in `Policy.check_run`.

`pandion_api.checks` reads a pipeline dict for a site's rules: `steps(config)` lists every
step as `(where, stage, use, settings)`, `custom_endpoint_steps(config)` names the steps
set to call a model at an address the request chose, and
`changed_read_only_settings(config)` names every setting marked read-only (the prompts,
the cross-encoder's revision) that is not at its default.

The `config` a Policy is given holds each value as the request sent it, not yet
validated. Pandion's settings are pydantic models, which later make the string `"16001"`
and the float `16001.0` the int `16001`. So a site that compares numbers must coerce them
first, for example with `pydantic.TypeAdapter(int).validate_python(value)`, or a string
or a float passes a cap that an int would not. A value that does not coerce can be left
alone: Pandion's own check refuses it as a problem (a 422, or `ok: false` from
`POST /pipelines/validate`).

The default Policy allows every setting. RAG Playground's Policy refuses with a 403 a
custom model endpoint on its hosted demo, a changed prompt or model revision in every
mode, `max_tokens` above 16,000 on a step that calls a model, and a text budget (a
setting named `..._budget_chars`) above four times its default. A cap reads the value as
pydantic will, so `"999999"` and `999999.0` are refused like `999999`.

## The playground on pandion-api

RAG Playground's server is `pandion_api.create_app(settings, PlaygroundPolicy())`
(`playground/backend/main.py`), with its routes under `/api/v2`, plus what is the playground's own: the
model warm-up, the web build, and its teaching routes under `/api`. The old `/api` routes
for runs, sweeps, the catalog, explanations, documents, results, the miss trace and keys
are gone; the web calls their `/api/v2` twins. The playground's own routes are
`GET /api/health`, `GET /api/samples`, `GET /api/samples/questions`,
`GET /api/samples/{name}/questions`, `POST /api/sources/sample`, `GET /api/learn/chunking`,
`GET /api/learn/document`, `GET /api/stages`, `GET /api/settings/app` (demo mode, its
limits and the visitor cookie), `GET /api/questions/template` and `GET /api/templates`
(the pipeline templates).
`tests/api/test_routes.py` pins that list.

`PlaygroundPolicy` (`playground/backend/policy.py`) is the hosted demo's rules:

| Rule | On the demo | Locally |
|---|---|---|
| `dependencies` | every `/api/v2` request gets a visitor cookie | the same |
| `can_read` | a sample, or this browser's own upload | any document |
| `check_upload` | a visitor cookie; at most 10 MB read | anything |
| `check_document` | for an upload and a URL document alike: a PDF of at most 20 pages, 41 inches a side; Word, PowerPoint, HTML, Markdown and text files up to 2 MB; a Word or PowerPoint file that unpacks to at most 50 MB in at most 1,000 parts (a zip bomb is a 413); a PNG or JPG up to 5 MB and 20 million pixels; a file with no extension only if it is a PDF; three live uploads a browser; 200 MB for all uploads | anything |
| `check_fetch` | a visitor cookie; room for one more upload (a URL document counts as one: 429); at most 10 links a browser an hour and 100 links an hour for every browser together, failed fetches included (429) | anything |
| `fetch_slot` | at most 2 fetches at once; a third is a 503 | no limit |
| `on_uploaded` (a URL document) | the link is kept under the browser that added it (`origin_urls`), never as a shared `origin_url`; `describe` shows a browser only its own link, and deleting or expiring its upload drops it | the same |
| `on_startup` (images) | `PIL.Image.MAX_IMAGE_PIXELS` is set to 20 million, so an image inside a Word, PowerPoint or HTML file cannot decode into huge memory | Pillow's default |
| `max_url_bytes` | 10 MB, the upload cap | 20 MB |
| `on_uploaded` | records which browser uploaded the file, and when | the same |
| `on_delete` | only your own upload; a file another browser holds stays; never a sample | any upload, never a sample |
| `describe` | the upload time: this browser's own when it uploaded the file, else the latest | the same |
| `private` | an upload's page images are cached privately, a sample's publicly | public |
| `document_name` | a sample seeded at startup takes its catalog filename | the same |
| `keeps_question_sets` | no: checked and handed back | yes |
| `check_run` | no custom endpoint; no changed prompt or model revision; `max_tokens` at most 16,000 on a step that calls a model; a text budget at most four times its default | the same, but a custom endpoint is allowed |
| `public_endpoints_only` | yes, for a custom endpoint and for a URL document: https on port 443, to a public address | no |
| `max_active_runs` | 2 | no limit |
| `max_variants` | 10 | 10 |
| `check_question_count` | at most 50 questions an evaluation, and 120 recipe-questions (recipes times questions) a comparison: a 413 naming the cap; at most 25 questions a model writes at a time: a 400 that says so | only the 500 a set, and 50 questions a model writes |
| `max_runs_per_owner` | 2 a visitor | no limit |
| `run_owner` | the visitor: to anyone else the run is a 404 | no one |
| `scrub` | a server path keeps only its last part (`[server]/x.py`) | the same |
| `credentials` | only the key in the request | the request, then the environment, then `.env` |
| `missing_key` | "type one in the UI", naming no server variable | also names the variable and `.env` |
| `check_provider` | a custom endpoint is not checked (403) | allowed |
| `check_clear_cache` | refused: every visitor shares the cache | allowed |
| `strategies` | no custom endpoint, no test embedder, no read-only settings | no read-only settings |
| `on_startup` | puts every sample's file in the store, and starts deleting uploads after 24 hours | puts every sample's file in the store |

A stored file is never written twice for the same bytes, and a name ending in `.part` is
refused. A question set is held to 1 MB, 500 questions and 20 gold passages a question.

The demo's rule tests (`tests/api/test_demo.py`, `test_delete_source.py`,
`test_source_file.py` and the rest) call `/api/v2` directly.

### Open items

Part 5 moved the web onto `/api/v2` and deleted the old routes. It also merged the two
embedding caches into `embeddings/`, removed the allow-list from
`tests/integration/test_package_boundary.py`, and made Compare send `through`, so each
variant stops after the card it shows. These are still open:

- **A body-size limit before the route.** A multipart upload is spooled to disk before a
  route's own cap reads it. A limit at the app, or at the proxy in front of it, would
  refuse a huge body before it is written.
- **Results readable by id.** `GET /results/{id}`, `POST /chunk-stats` and `POST /trace` answer any visitor
  who has a result's id. An id is a content hash that needs the upload's bytes to
  compute. A per-visitor check would be a new Policy hook.
- **Time spent checking a question set.** Gold passages are matched in a worker thread
  with no time cap. The caps on size and count bound it, but not by the clock.
- **Runs do not hold the pdfium lock.** A page request and a question-set check hold
  `pandion_api.pages.PDFIUM_LOCK`, but a run's pdfium parse step does not. pdfium is not
  thread-safe, so a run that parses with pdfium can still meet a page request on another
  thread.

## Errors

- A pipeline Pandion refuses is a 422 whose detail is `{"problems": [<sentence>],
  "details": [{"message", "step", "use", "settings"}]}`: the `ConfigError`'s one-line
  message, and the same problem placed (`ConfigError.to_dict()`), so a client shows it on
  the step and under the setting it belongs to without reading the sentence. `step` is the
  step's place in the pipeline file, such as `index.clean.2` or `retrieve.rerank`, or null.
  Run events name steps by role instead (`clean.2`, `rerank.1`, and `index` for embed and
  store), so the two are not the same text; `settings` lists
  each refused setting with its own sentence. `POST /pipelines/validate` gives the same
  problems and details in a 200. A pipeline that is not a mapping, lists `plugins` or has a `models` that is not a
  mapping is refused the same way, before Pandion reads it.
- A site rule's refusal is the status and sentence the Policy raised, usually 403.
- A refused URL document is a 400, 403, 413, 415, 502 or 504 with the fetch guard's own
  sentence (see [URL documents](#url-documents)). It never repeats the URL or anything
  the page sent.
- An unknown stage or strategy in `POST /explain` is a 404 naming the ones there are.
- `Policy.scrub` runs over the sentences that could carry a server path: a `ConfigError`'s
  problem (on every route that reads a pipeline, and on `POST /pipelines/validate`), the
  problem and the 404 of `POST /explain`, and every error a run shows (a failed step's
  `error` and a crash's `run_error`, after the keys are taken out).
- Every other sentence is returned as Pandion or the route wrote it, unscrubbed: Pandion's
  own refusals (such as a `through` that names no step), the question-set 400s and 413,
  and the route's fixed sentences. None of them holds a server path.
