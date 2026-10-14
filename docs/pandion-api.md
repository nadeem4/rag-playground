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
| `POST /runs` | `{"config", "documents": [id, ...], "through"?, "force"?}`: index the documents, or stop each after one step (`parse`, `clean`, `clean.N`, `chunk`; `index` is the whole run). 202 `{"run_id"}`. |
| `GET /runs/{run_id}` | the run's status, its whole event log, and once it ended its `result` |
| `GET /runs/{run_id}/events` | the events as server-sent events; reconnect with `Last-Event-ID` or `?last_event_id=N` |
| `POST /runs/{run_id}/cancel` | stop the run between steps: 202, or 409 when it already ended |
| `POST /ask` | `{"config", "documents", "question", "k"?, "answer"?, "force"?}`: search the documents for the question, and answer it unless `answer` is false. A run: 202 `{"run_id"}`. |

A document this caller may not read is answered exactly like one that does not exist: 404,
with the same fixed sentence, which never repeats the id the request sent. A page number past the last page is 404, and a `scale` or `text`
outside its range is 422. pdfium is not thread-safe, so every page request holds
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

A document in a run is named by the filename it was uploaded under, so the same bytes
under the same name give the same result ids however often they are uploaded. Two
documents in one run cannot share a name.

A model's key comes from the request's header for its provider (`X-Anthropic-Api-Key`,
`X-OpenAI-Api-Key`, `X-Custom-Api-Key`, `X-OpenRouter-Api-Key`), else from the server's
environment variable, as the Policy's `key` decides. It is never stored or logged, and it
is scrubbed from every event and result.

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
| `max_active_runs()` | None (no limit) | when a run starts: past the limit it waits its turn and logs `queued` |
| `strategies(catalog, request)` | the catalog as it is | `GET /strategies`; return a changed copy to hide a strategy or a choice |
| `check_run(config, request)` | allows | before any pipeline runs or validates; `config` is the file's shape with the server's path and models |
| `public_endpoints_only(request)` | `False` | every pipeline: a custom model endpoint must then be a public https address |
| `run_owner(request)` | None (anyone) | when a run starts, and on its state, events and cancel: a run with an owner is a 404 to anyone else |
| `scrub(text)` | the text as it is | on every problem sentence and every 404 sentence before it leaves the server (`POST /explain`, `POST /pipelines/validate`), and on every error a run shows |
| `not_readable` (attribute) | "This document is not available." | the 403 a run gets for a document `can_read` refuses |
| `server_key(provider)` | the environment variable, else `(None, "none")` | a run's keys, and `GET /settings/models` |
| `key(provider, request)` | the header, else `server_key` | a run's keys, and the key check |
| `credentials(request)` | every provider whose `key` resolves | every run |
| `on_startup(app)`, `on_shutdown(app)` | nothing | once each, around serving |

A document's record may hold more keys than a client is shown: a Policy keeps what it
needs there (for example who uploaded the file) through `on_uploaded`, and reads it back
as `document.extra`. Hold `pandion_api.documents.SIDECAR_LOCK` (or `DocumentStore.lock`)
around any change you make to a record yourself.

RAG Playground's Policy gives every `/api/v2` request a visitor cookie, and on its hosted
demo holds uploads to the demo's limits (a PDF of at most 10 MB and 20 pages, no page over
41 inches a side, three live uploads a visitor, a cap on the whole disk), shows a visitor
the samples and only their own uploads, and deletes only their own upload, keeping a
file another visitor also uploaded. On the demo an upload's page images are cached privately, a sample's publicly. The old `/api/sources` routes call the same Policy.
On the demo a run is its visitor's own, on `/api/v2` and on the old `/api/runs/{id}` routes,
which share the run manager. In every mode its errors keep only the last part of any
server path (`[server]/x.py`).

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

The default Policy allows every setting. RAG Playground's Policy refuses with a 403 a
custom model endpoint on its hosted demo, a changed prompt or model revision in every
mode, `max_tokens` above 16,000 on a step that calls a model, and a text budget (a
setting named `..._budget_chars`) above four times its default. Its old `/api/runs` and
`/api/sweeps` routes refuse the same caps on each graph node with the same function
(`api.policy.step_over_limit`).

## Errors

- A pipeline Pandion refuses is a 422 whose detail is `{"problems": [<sentence>]}`, the
  `ConfigError`'s one-line message. `POST /pipelines/validate` gives the same problems in
  a 200. A pipeline that is not a mapping, lists `plugins` or has a `models` that is not a
  mapping is refused the same way, before Pandion reads it.
- A site rule's refusal is the status and sentence the Policy raised, usually 403.
- An unknown stage or strategy in `POST /explain` is a 404 naming the ones there are.
- Every problem and 404 sentence passes through `Policy.scrub` before it leaves the
  server. A `ConfigError` names settings and strategies, never a server folder.
