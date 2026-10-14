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
sends, so a name never chooses where a file goes.

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
| `max_active_runs()` | None (no limit) | when a run starts: past the limit it waits its turn and logs `queued` |
| `strategies(catalog, request)` | the catalog as it is | `GET /strategies`; return a changed copy to hide a strategy or a choice |
| `check_run(config, request)` | allows | before any pipeline runs or validates; `config` is the file's shape with the server's path and models |
| `public_endpoints_only(request)` | `False` | every pipeline: a custom model endpoint must then be a public https address |
| `run_owner(request)` | None (anyone) | not yet called: the run routes will start a run for whoever it names, and only they may follow or cancel it |
| `scrub(text)` | the text as it is | on every problem sentence and every 404 sentence before it leaves the server (`POST /explain`, `POST /pipelines/validate`); the run routes will use it too |
| `on_startup(app)`, `on_shutdown(app)` | nothing | once each, around serving |

A document's record may hold more keys than a client is shown: a Policy keeps what it
needs there (for example who uploaded the file) through `on_uploaded`, and reads it back
as `document.extra`. Hold `pandion_api.documents.SIDECAR_LOCK` (or `DocumentStore.lock`)
around any change you make to a record yourself.

RAG Playground's Policy gives every `/api/v2` request a visitor cookie, and on its hosted
demo holds uploads to the demo's limits (a PDF of at most 10 MB and 20 pages, no page over
41 inches a side, three live uploads a visitor, a cap on the whole disk), shows a visitor
the samples and only their own uploads, and deletes only their own upload, keeping a
file another visitor also uploaded. The old `/api/sources` routes call the same Policy.

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
