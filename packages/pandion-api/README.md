# pandion-api

pandion-api serves [Pandion](../pandion/README.md) over REST. It is a FastAPI app factory:
`create_app` gives you a FastAPI app with Pandion's documents, runs, questions,
evaluations and comparisons as HTTP routes. RAG Playground mounts it at `/api/v2`.

Every route that takes a pipeline takes the pipeline file's shape as JSON, the same dict
`Pipeline.from_dict` reads. Everything a site wants to limit is one `Policy` object, and
the default allows everything. It is a workspace package in this repository and is not
on PyPI yet.

[docs/pandion-api.md](../../docs/pandion-api.md) is the full reference.

## Run it

```python
# serve.py
from pathlib import Path

from pandion_api import ApiSettings, create_app

app = create_app(ApiSettings(data_dir=Path("./pandion-data"), prefix="/api/v2"))
```

```bash
uvicorn serve:app
```

With no `prefix` the routes sit at the root, so once it runs, `curl http://127.0.0.1:8000/health`
(or `/api/v2/health` with the prefix above) is the first call. The reference has a
[step by step first run](../../docs/pandion-api.md#a-first-run-step-by-step).

`ApiSettings` takes `data_dir`, the one folder every request runs under. It also takes
`models` (a `pandion.ModelSettings`), `prefix` (where the routes are mounted) and `title`.
Pass a `Policy` as the second argument to `create_app` to set your site's rules.

[examples/pandion-api/](../../examples/pandion-api) has a server script, a Python client
that validates, uploads, indexes, asks and evaluates, the same steps as curl commands,
and a small Policy.

## The routes

Each path is under `prefix`.

| Route | What it does |
|---|---|
| `GET /health` | Says the server is up, with the Pandion and pandion-api versions. |
| `GET /strategies` | Lists every strategy by step, with its settings as a JSON schema. |
| `POST /explain` | Says in plain words what a strategy will do with given settings. |
| `POST /pipelines/validate` | Checks a pipeline and returns it as a YAML file, or the problems. |
| `GET /documents` | Lists the documents this caller may read. |
| `POST /documents` | Stores an uploaded file by its fingerprint. |
| `POST /documents/url` | Fetches one web page and stores it like an upload, with its link as `origin_url`. |
| `DELETE /documents/{id}` | Deletes a document, its record and its question set. |
| `GET /documents/{id}/file` | Returns the file's own bytes. |
| `GET /documents/{id}/pages` | Returns each page's size. |
| `GET /documents/{id}/pages/{n}` | Returns one page as a PNG image. |
| `GET /documents/{id}/pages/{n}/find` | Finds where a piece of text is on a page. |
| `POST /documents/{id}/questions` | Checks a question set against the document, and keeps it if the Policy says so. |
| `GET /documents/{id}/questions` | Returns the question set kept for a document. |
| `DELETE /documents/{id}/questions` | Removes that question set. |
| `POST /documents/{id}/questions/generate` | Has a model write test questions for a document, as a run. |
| `POST /questions` | Checks one question set against several documents, and keeps it if the Policy says so. |
| `GET /questions` | Returns the question sets kept against several documents, as one. |
| `POST /golds/find` | Says which piece first holds a gold passage, by the eval step's rule. |
| `POST /evaluations/against` | Compares a run with a baseline: questions newly missed and newly found, and which run is better. |
| `POST /pipelines/sort` | Shows which category each document would go to and why. Nothing runs. |
| `POST /runs` | Starts a run that indexes documents, or stops after one step. |
| `GET /runs/{run_id}` | Returns a run's status, its events and its result. |
| `GET /runs/{run_id}/events` | Streams a run's events as server-sent events. |
| `POST /runs/{run_id}/cancel` | Stops a run between steps. |
| `POST /ask` | Searches the documents for a question, and answers it. |
| `POST /evaluations` | Checks whether each question's answer came back, and which step lost a miss. |
| `POST /comparisons` | Runs one step's variants side by side and names the best. |
| `GET /results/{id}` | Returns a stored result's type and details. |
| `GET /results/{id}/payload` | Returns the stored result itself. |
| `POST /chunk-stats` | Sums up several chunk sets, one chunker's over several documents, as one. |
| `DELETE /cache` | Removes every stored result and the embedding cache, and keeps the documents. |
| `GET /settings/models` | Says where the server's own key for each provider comes from, never the key. |
| `POST /settings/models/check` | Checks that the key a request would use works. |
| `POST /trace` | Follows one missed question step by step through a finished run. |

Every run's result carries `usage` on each step (the token counts and model ids of its
model call, or null) and `cost` on each report (seconds, tokens and estimated dollars).
[Speed and cost](../../docs/pandion-api.md#speed-and-cost) lists the fields.

## The Policy

A site subclasses `pandion_api.Policy` and overrides only what it needs. A method refuses
by raising `fastapi.HTTPException`. These are the hooks, from `pandion_api/policy.py`:

- `dependencies()`: FastAPI dependencies to run on every route, such as one that sets a cookie.
- `can_read(sha, request)`: may this request read this document?
- `check_upload(file, request)`: read an upload and return its bytes, or refuse it.
- `check_document(data, filename, request)`: refuse a document's bytes, for an upload and a URL document alike.
- `check_fetch(url, request)`: refuse a link before it is fetched.
- `fetch_slot(request)`: a context manager the fetch runs inside, for example to limit fetches at once.
- `max_url_bytes(request)`: the largest page a link may fetch (20 MB by default).
- `on_uploaded(document, request)`: called right after an upload's record is written.
- `on_delete(sha, document, request)`: refuse a delete, or say whether to delete the file now.
- `describe(document, request)`: extra keys to add to a document in the list.
- `private(sha, request)`: is this document one caller's own, so its page images are cached privately?
- `keeps_question_sets(request)`: keep a checked question set, or only check it?
- `max_active_runs()`: how many runs may work at once.
- `strategies(catalog, request)`: the strategy list a caller is shown.
- `check_run(config, request)`: refuse a pipeline before it runs.
- `public_endpoints_only(request)`: accept only a public https address for a custom model endpoint?
- `max_variants(request)`: how many variants one comparison may run.
- `check_question_count(kind, count, request)`: refuse an evaluation or comparison with too many questions.
- `max_runs_per_owner(request)`: how many runs one owner may have at once.
- `run_owner(request)`: who a run belongs to.
- `check_clear_cache(request)`: refuse `DELETE /cache`.
- `server_key(provider)`: the key the server itself has for a provider, and where it came from.
- `key(provider, request)`: the key for this request, and where it came from.
- `credentials(request)`: the keys a run gets.
- `missing_key(provider)`: what a key check says when there is no key.
- `check_provider(provider, request)`: refuse a key check for a provider.
- `scrub(text)`: an error message as it may leave the server.
- `on_startup(app)` and `on_shutdown(app)`: called once as the server starts and stops.

Two class attributes set wording: `not_readable` is the message for a document the caller
may not read, and `not_keeping_note` is what a question set report says when the set was
not kept.

## How the playground uses it

The playground's backend, in [playground/backend/](../../playground/backend/README.md),
calls `create_app` with `ApiSettings(prefix="/api/v2")` and `PlaygroundPolicy`, the hosted
demo's rules. It then adds its own routes under `/api` and serves the web app.
