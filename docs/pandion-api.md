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
| `POST /pipelines/validate` | `{"config": <pipeline>}` gives `{"ok": true, "problems": [], "config": <the pipeline in the file's shape>}` or `{"ok": false, "problems": [<sentence>]}` |
| `GET /documents` | the documents this caller may read, by name: `sha`, `filename`, `size`, `content_type`, plus what the Policy's `describe` adds. Never cached. |
| `POST /documents` | multipart `file`: keeps it by its fingerprint and returns its record. The same bytes twice are one document. |
| `DELETE /documents/{id}` | `{"sha", "deleted"}`: deletes the file, its record and its question set, if the Policy agrees |
| `GET /documents/{id}/file` | the file's own bytes. Never cached. |
| `GET /documents/{id}/pages` | each page's size in PDF points: `[{"n", "width", "height"}]` |
| `GET /documents/{id}/pages/{n}?scale=1` | the page as PNG, `scale` above 0 and at most 8, lowered so the image stays within 25 million pixels |
| `GET /documents/{id}/pages/{n}/find?text=` | where the text (1 to 2,000 characters) is on the page: `{"rects": [[left, bottom, right, top], ...], "matched": "exact" or "normalized" or "none"}` |
| `POST /documents/{id}/questions` | multipart `file`, a question set as JSON or CSV: checks every gold passage against the document as pdfium reads it, keeps the set if the Policy keeps sets, and reports per question whether each passage was found. A set over 1 MB is 413; a set that cannot be used (more than 500 questions, more than 20 gold passages in one, a file that cannot be read) is 400 with its sentence; a document that is not a PDF is 415. |
| `GET /documents/{id}/questions` | the set kept for the document, or `null` |
| `DELETE /documents/{id}/questions` | remove it: 204 |
| `POST /runs` | `{"config", "documents": [id, ...], "through"?, "force"?}`: index the documents, or stop each after one step (`parse`, `clean`, `clean.N`, `chunk`; `index` is the whole run). 202 `{"run_id"}`. |
| `GET /runs/{run_id}` | the run's status, its whole event log, and once it ended its `result` |
| `GET /runs/{run_id}/events` | the events as server-sent events; reconnect with `Last-Event-ID` or `?last_event_id=N` |
| `POST /runs/{run_id}/cancel` | stop the run between steps: 202, or 409 when it already ended |
| `POST /ask` | `{"config", "documents", "question", "k"?, "answer"?, "force"?}`: search the documents for the question (at most 2,000 characters; `k` 1 to 100), and answer it unless `answer` is false. A run: 202 `{"run_id"}`. |
| `POST /evaluations` | `{"config", "documents", "questions"?, "top_k"?}`: search for every question and say whether its answer came back, and for a miss the step that lost it (`pandion.evaluate`). Without `questions`, the sets kept against the documents. A run; its result is the report's `to_dict()`. |
| `POST /comparisons` | `{"config", "stage", "variants", "documents", "questions"?, "top_k"?, "through"?}`: run the pipeline once per variant of one stage (at most the Policy's `max_variants`, ten by default) and evaluate each with the questions sent (`pandion.compare`). Without `questions` it is index only, and `through` can stop each variant after a step, as for `POST /runs`. A run; its result names the best. |
| `GET /results/{id}` | a stored result's `id`, `type` and `meta` (a `result_id` from a run) |
| `GET /results/{id}/payload` | the result itself; for an index, the description its store left (LanceDB's backends and counts) |
| `DELETE /cache` | remove every stored result and the embedding cache, keep the documents: `{"results", "bytes", "complete"}`. 409 while a run works. |
| `GET /settings/models` | where the server's own key for each provider comes from (`env`, or `none`; the Policy may name others), never a key |
| `POST /settings/models/check` | `{"provider", "base_url"?}`: whether the key this request would use works, with one call that costs no tokens (a model listing, or OpenRouter's key endpoint): `{"ok", "source", "error"}`. A custom endpoint needs `base_url`, which must pass the same address check as a run; an unknown provider is 422. The key is never echoed, and an error has it taken out. |
| `POST /trace` | why one question missed, followed step by step down a finished run's results (`pandion.evaluation.trace`) |

A document this caller may not read is answered exactly like one that does not exist: 404,
with the same fixed sentence, which never repeats the id the request sent. A page
number past the last page is 404, and a `scale` or `text` outside its range is 422.
pdfium is not thread-safe, so every page request and every question-set check holds
`pandion_api.pages.PDFIUM_LOCK`; anything else in the same process that uses pdfium on
request threads should hold it too.

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

An evaluation's events carry the question's id under `question`, with a `question_finished`
event after each. A comparison's carry the variant's number under `variant`. Every variant
is checked like a pipeline before anything runs, so a variant the Policy refuses is
refused at once. A variant is taken as `pandion.compare` takes it: a bare name is
`{"use": name}`, and one block for `clean` or `rerank` is a list of one. A question set
in the request is held to the caps of an uploaded one (over 1 MB is 413; more than 500
questions, or more than 20 gold passages in one, is 400 with its sentence).

An evaluation sent without questions asks those of the sets kept against its documents,
in the order the documents are listed. An id that two documents' sets both use is
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

## Site rules: the Policy

Subclass `pandion_api.Policy` and override what your site needs. A method that refuses
raises `fastapi.HTTPException` with the status and the sentence the caller should see.

| Method | Default | Called |
|---|---|---|
| `dependencies()` | `[]` | FastAPI dependencies run on every route |
| `can_read(sha, request)` | `True` | the list, a document's file, pages and questions (404 when False), and a run on it (403) |
| `check_upload(file, request)` | reads it all | `POST /documents`: return the bytes, or raise to refuse. Read no more than you accept. |
| `on_uploaded(document, request)` | nothing | with the store's lock held, after the record is written |
| `on_delete(sha, document, request)` | 404 without a record, else `True` | with the lock held: `True` deletes the file, `False` keeps it |
| `describe(document, request)` | `{}` | keys added to each document in the list |
| `private(sha, request)` | `False` | a page image's Cache-Control: private when True |
| `keeps_question_sets(request)` | `True` | `POST /documents/{id}/questions`: False checks the set and keeps nothing |
| `max_active_runs()` | None (no limit) | when a run starts: past the limit it waits its turn and logs `queued` |
| `strategies(catalog, request)` | the catalog as it is | `GET /strategies`; return a changed copy to hide a strategy or a choice |
| `check_run(config, request)` | allows | before any pipeline runs or validates; `config` is the file's shape with the server's path and models, and holds each value as the request sent it (see below) |
| `public_endpoints_only(request)` | `False` | every pipeline: a custom model endpoint must then be a public https address |
| `check_clear_cache(request)` | allows | `DELETE /cache` |
| `max_variants(request)` | 10 | `POST /comparisons`: more variants than this is a 422 |
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
pydantic will, so `"999999"` and `999999.0` are refused like `999999`. Its old `/api/runs` and
`/api/sweeps` routes refuse the same caps on each graph node with the same function
(`api.policy.step_over_limit`).

## The playground on pandion-api

RAG Playground's server is `pandion_api.create_app(settings, PlaygroundPolicy())`
(`api/main.py`), with its routes under `/api/v2`, plus what is the playground's own:
the old `/api` routes the web uses until part 5, the samples (`/api/samples`,
`/api/sources/sample`), the lessons (`/api/learn`), the stage copy (`/api/stages`),
`/api/settings/app` (demo mode, its limits and the visitor cookie), the question-set
template, the model warm-up, and the web build.

`PlaygroundPolicy` (`api/policy.py`) is the hosted demo's rules. Each calls the function
the old route uses, or the old route calls it, so the two cannot drift apart:

| Rule | On the demo | Locally |
|---|---|---|
| `dependencies` | every `/api/v2` request gets a visitor cookie | the same |
| `can_read` | a sample, or this browser's own upload | any document |
| `check_upload` | a visitor cookie; at most 10 MB, a PDF, 20 pages, 41 inches a side; three live uploads a browser; 200 MB for all uploads | anything |
| `on_uploaded` | records which browser uploaded the file, and when | the same |
| `on_delete` | only your own upload; a file another browser holds stays; never a sample | any upload, never a sample |
| `describe` | the upload time: this browser's own when it uploaded the file, else the latest | the same |
| `private` | an upload's page images are cached privately, a sample's publicly | public |
| `keeps_question_sets` | no: checked and handed back | yes |
| `check_run` | no custom endpoint; no changed prompt or model revision; `max_tokens` at most 16,000 on a step that calls a model; a text budget at most four times its default | the same, but a custom endpoint is allowed |
| `public_endpoints_only` | yes | no |
| `max_active_runs` | 2 | no limit |
| `max_variants` | 10 | 10 |
| `run_owner` | the visitor: to anyone else the run is a 404 | no one |
| `scrub` | a server path keeps only its last part (`[server]/x.py`) | the same |
| `credentials` | only the key in the request | the request, then the environment, then `.env` |
| `missing_key` | "type one in the UI", naming no server variable | also names the variable and `.env` |
| `check_provider` | a custom endpoint is not checked (403) | allowed |
| `check_clear_cache` | refused: every visitor shares the cache | allowed |
| `strategies` | no custom endpoint, no test embedder, no read-only settings | no read-only settings |
| `on_startup` | puts every sample's file in the store, and starts deleting uploads after 24 hours | puts every sample's file in the store |

The old routes ask the same rules. `POST /api/sources` calls `check_upload` and
`on_uploaded`, the old delete calls `on_delete`, the old page route asks `private`, the
old question-set route asks `keeps_question_sets`, `DELETE /api/cache` asks
`check_clear_cache`, and the old key check asks `check_provider`. `/api/runs` and
`/api/sweeps` refuse the same caps with `api.policy.step_over_limit`, and their runs share
the one run manager, so the demo's two at once hold across both stacks and a run is its
visitor's own on `/api/runs/{id}` too. A stored file is never written twice for the same
bytes on `/api/v2`, and a name ending in `.part` is refused on both stacks. A question
set is held to 1 MB, 500 questions and 20 gold passages a question on both stacks.

`tests/api/test_v2_parity.py` runs today's tests of these rules a second time against
`/api/v2`, and fails if a new rule test neither runs there nor says why. A test that
cannot run there (it sends a graph, or reads `/api/settings/app`, which stays) is in its
`EXCLUDED` list with the reason and, where there is one, the `/api/v2` test that proves
the same rule.

### What part 5 must decide

Part 5 moves the web onto `/api/v2` and deletes the old routes. These were left for it:

- **A body-size limit before the route.** A multipart upload is spooled to disk before a
  route's own cap reads it. A limit at the app, or at the proxy in front of it, would
  refuse a huge body before it is written.
- **A per-visitor queue cap.** The demo lets two runs work at once; the rest wait. One
  visitor can still queue many runs.
- **Results readable by id.** `GET /results/{id}` and `POST /trace` answer any visitor
  who has a result's id, as today's `/api/artifacts` and `/api/trace` do. An id is a
  content hash that needs the upload's bytes to compute. A per-visitor check would be
  a new Policy hook.
- **Time spent checking a question set.** Gold passages are matched in a worker thread
  with no time cap. The caps on size and count bound it, but not by the clock.
- **Two embedding caches.** The old routes cache embeddings in `artifacts/.embcache` (or
  `RAG_PLAYGROUND_EMBED_CACHE`), `/api/v2` in `embeddings/`. Deleting the old routes
  deletes the variable and the old cache.
- **The allow-list cannot just be deleted.** `ENGINE_IMPORTS` in
  `tests/integration/test_package_boundary.py` lists engine names the app still imports.
  Deleting the old routes is not enough to empty it: these playground parts use engine
  internals too, and each needs porting to Pandion's public API or removing:
  `api/routes/learn.py` (the lessons), `api/warmup.py` (the model warm-up), `api/deps.py`
  (the store, the sources and the embedding cache), `POST /api/sources/sample`, and the
  recording scripts `scripts/record_*.py`.
- **Runs do not hold the pdfium lock.** A page request and a question-set check hold
  `pandion_api.pages.PDFIUM_LOCK`, but a run's pdfium parse step does not. pdfium is not
  thread-safe, so a run that parses with pdfium can still meet a page request on another
  thread. Part 5 decides whether Pandion's pdfium step takes a lock of its own.
- **Compare's per-card `through`.** `POST /comparisons` now takes `through`, so Compare's
  Build view can stop each variant after one card without embedding every variant, as the
  old `/api/sweeps` does. Part 5 checks it covers what Build needs.

## Errors

- A pipeline Pandion refuses is a 422 whose detail is `{"problems": [<sentence>]}`, the
  `ConfigError`'s one-line message. `POST /pipelines/validate` gives the same problems in
  a 200. A pipeline that is not a mapping, lists `plugins` or has a `models` that is not a
  mapping is refused the same way, before Pandion reads it.
- A site rule's refusal is the status and sentence the Policy raised, usually 403.
- An unknown stage or strategy in `POST /explain` is a 404 naming the ones there are.
- `Policy.scrub` runs over the sentences that could carry a server path: a `ConfigError`'s
  problem (on every route that reads a pipeline, and on `POST /pipelines/validate`), the
  problem and the 404 of `POST /explain`, and every error a run shows (a failed step's
  `error` and a crash's `run_error`, after the keys are taken out).
- Every other sentence is returned as Pandion or the route wrote it, unscrubbed: Pandion's
  own refusals (such as a `through` that names no step), the question-set 400s and 413,
  and the route's fixed sentences. None of them holds a server path.
